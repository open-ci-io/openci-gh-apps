/* eslint-disable @typescript-eslint/no-explicit-any */
import { onRequest } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { Context, Probot } from "probot";
import { BuildModel } from "./models/BuildModel";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { WorkflowData } from "./models/WorkFlowData";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
const { v4: uuidv4 } = require("uuid");

const jobsCollectionName = "jobs_v3";
const workflowCollectionName = "workflows_v1";

admin.initializeApp();
const firestore = getFirestore();

exports.getInstallationToken = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const { appId, privateKey, installationId } = req.body;

  if (!appId || !privateKey || !installationId) {
    res.status(400).send("Missing required parameters");
    return;
  }

  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: appId,
      privateKey: privateKey,
      installationId: installationId,
    },
  });

  try {
    const { data } = await appOctokit.rest.apps.createInstallationAccessToken({
      installation_id: installationId,
    });

    res.status(200).json({ installationToken: data.token });
  } catch (error) {
    console.error("Error creating installation token:", error);
    res.status(500).send("Internal Server Error");
  }
});

export const updateCheckStateFunction = onDocumentUpdated(
  `${jobsCollectionName}/{documentId}`,
  async (event) => {
    if (event.data == undefined) {
      throw new Error("Build model is undefined");
    }
    const buildId = event.params.documentId;
    const oldStatus = event.data.before.data().buildStatus;
    const newStatus = event.data.after.data().buildStatus;
    const { platform, workflowId, github, githubChecks } =
      event.data.after.data();

    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.APP_ID,
        privateKey: process.env.PRIVATE_KEY,
        installationId: github.installationId,
      },
    });

    if (oldStatus.failure !== newStatus.failure) {
      if (newStatus.failure) {
        const response = await octokit.checks.update({
          check_run_id: githubChecks.checkRunId,
          owner: github.owner,
          status: "completed",
          conclusion: "failure",
          repo: github.repositoryName,
        });
        console.log("Check status updated successfully:");
        console.log(response.data);
        console.log(`Build ${buildId}: Failure status changed to true`);
      }
    }
    if (oldStatus.processing !== newStatus.processing) {
      if (newStatus.processing) {
        const response = await octokit.checks.update({
          check_run_id: githubChecks.checkRunId,
          status: "in_progress",
          owner: github.owner,
          repo: github.repositoryName,
        });
        console.log("Check status updated successfully:");
        console.log(response.data);
        console.log(`Build ${buildId}: Processing status changed to true`);
      }
    }

    if (oldStatus.success !== newStatus.success) {
      if (newStatus.success) {
        const response = await octokit.checks.update({
          check_run_id: githubChecks.checkRunId,
          owner: github.owner,
          status: "completed",
          conclusion: "success",
          repo: github.repositoryName,
        });
        console.log("Check status updated successfully:");
        console.log(response.data);
        console.log(`Build ${buildId}: Success status changed to true`);
        console.log("workflowId", workflowId);

        const workflowQuerySnapshot = await firestore
          .collection(workflowCollectionName)
          .where("documentId", "==", workflowId)
          .get();

        const workflowQueryDocumentSnapshot = workflowQuerySnapshot.docs[0];

        console.log(
          "workflowQueryDocumentSnapshot",
          workflowQueryDocumentSnapshot.exists
        );
        const workflowData =
          workflowQueryDocumentSnapshot.data() as WorkflowData;

        const organizationId = workflowData.organizationId;

        const organizationQuerySnapshot = await firestore
          .collection("organizations")
          .where("documentId", "==", organizationId)
          .get();

        const organizationData = organizationQuerySnapshot.docs[0].data();

        let retrievedBuildNumber = 0;

        const { buildNumber } = organizationData;

        if (platform == "ios") {
          retrievedBuildNumber = buildNumber.ios;
        } else if (platform == "android") {
          retrievedBuildNumber = buildNumber.android;
        }

        await addIssueComment(
          octokit,
          platform,
          workflowData.organizationId,
          retrievedBuildNumber,
          workflowData.workflowName,
          githubChecks.issueNumber,
          github.owner,
          github.repositoryName
        );
      }
    }
  }
);

export const probotFunction = onRequest(async (request, response) => {
  const name =
    request.get("x-github-event") || (request.get("X-GitHub-Event") as any);
  const id =
    request.get("x-github-delivery") ||
    (request.get("X-GitHub-Delivery") as any);

  const probot = new Probot({
    appId: process.env.APP_ID,
    privateKey: process.env.PRIVATE_KEY,
    secret: process.env.WEBHOOK_SECRET,
  });

  await probot.load(appFunction);

  await probot.receive({
    name,
    id,
    payload: request.body,
  });

  response.send({
    statusCode: 200,
    body: JSON.stringify({
      message: "Executed",
    }),
  });
});

const appFunction = async (app: Probot) => {
  app.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
      // this is for debug
      "pull_request.edited",
    ],
    async (context: Context<"pull_request">) => {
      const pullRequest = context.payload.pull_request;
      const installationId = context.payload.installation;
      const githubRepositoryUrl = pullRequest.base.repo.html_url;
      if (installationId == null) {
        throw new Error("installationId is null, please check it.");
      }

      const workflowQuerySnapshot = await getWorkflowQuerySnapshot(
        githubRepositoryUrl
      );

      for (const workflowsDocs of workflowQuerySnapshot.docs) {
        const workflowData = workflowsDocs.data();
        const { baseBranch, platform, workflowName } =
          workflowData as WorkflowData;

        if (pullRequest.base.ref === baseBranch) {
          const buildBranch = context.payload.pull_request.head.ref;
          const baseBranch = context.payload.pull_request.base.ref;

          const _checks = await createChecks(context, workflowName);

          const buildStatus = {
            processing: false,
            failure: false,
            success: false,
          };
          const branch = {
            baseBranch: baseBranch,
            buildBranch: buildBranch,
          };
          const githubChecks = {
            issueNumber: context.payload.pull_request.number,
            checkRunId: _checks.data.id,
          };

          const appId = process.env.APP_ID;
          if (appId == undefined) {
            throw new Error("appId is null, please check it.");
          }

          const github = {
            repositoryUrl: githubRepositoryUrl,
            owner: context.payload.repository.owner.login,
            repositoryName: context.payload.repository.name,
            installationId: installationId.id,
            appId: Number(appId),
          };
          const createdAt = admin.firestore.FieldValue.serverTimestamp();
          const documentId = uuidv4();
          const job = new BuildModel(
            buildStatus,
            branch,
            githubChecks,
            github,
            createdAt,
            documentId,
            platform,
            workflowsDocs.id
          );
          await firestore
            .collection(jobsCollectionName)
            .doc(job.documentId)
            .set(job.toJson());
        }
      }
    }
  );
};
async function addIssueComment(
  octokit: Octokit,
  platform: string,
  organizationId: string,
  buildNumber: number,
  workflowName: string,
  issueNumber: number,
  owner: string,
  repositoryName: string
): Promise<void> {
  const _issueCommentBody = issueCommentBody(workflowName, buildNumber);

  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: owner,
      repo: repositoryName,
      issue_number: issueNumber,
    });

    const existingComment = comments.find((comment) =>
      comment.body?.startsWith(issueCommentBodyBase(workflowName))
    );

    if (existingComment) {
      await octokit.rest.issues.updateComment({
        owner: owner,
        repo: repositoryName,
        comment_id: existingComment.id,
        body: _issueCommentBody,
      });
    } else {
      await octokit.rest.issues.createComment({
        owner: owner,
        repo: repositoryName,
        issue_number: issueNumber,
        body: _issueCommentBody,
      });
    }

    await updateBuildNumber(platform, organizationId, buildNumber);
  } catch (error) {
    console.error("Error adding or updating issue comment:", error);
  }
}

async function updateBuildNumber(
  platform: string,
  organizationId: string,
  buildNumber: number
) {
  const updateField = platform === "android" ? "android" : "ios";

  const body = {
    buildNumber: {
      [updateField]: buildNumber + 1,
    },
  };
  await firestore.collection("organizations").doc(organizationId).update(body);
}

function issueCommentBody(workflowName: string, buildNumber: number) {
  return `${issueCommentBodyBase(workflowName)} ${buildNumber}`;
}

function issueCommentBodyBase(workflowName: string) {
  return `${workflowName}: Build Number:`;
}

async function getWorkflowQuerySnapshot(githubRepositoryUrl: string) {
  const workflowQuerySnapshot = await firestore
    .collection(workflowCollectionName)
    .where("githubRepositoryUrl", "==", githubRepositoryUrl)
    .get();

  if (workflowQuerySnapshot.empty) {
    throw new Error("OpenCI could not find the repository in our database.");
  }
  return workflowQuerySnapshot;
}

async function createChecks(context: Context<"pull_request">, name: string) {
  try {
    return await context.octokit.checks.create({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      head_sha: context.payload.pull_request.head.sha,
      name: name,
      status: "queued",
    });
  } catch (error) {
    console.error("Failed to create check suite:", error);
    throw error;
  }
}
