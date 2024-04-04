/* eslint-disable @typescript-eslint/no-explicit-any */
import { onRequest } from "firebase-functions/v2/https";

import { Context, Probot } from "probot";
import { BuildModel } from "./models/BuildModel";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { WorkflowData } from "./models/WorkFlowData";

const jobsCollectionName = "jobs_v3";
const workflowCollectionName = "workflows_v1";

admin.initializeApp();
const firestore = getFirestore();

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

      const octokit = await app.auth(installationId.id);
      const { token } = (await octokit.auth({ type: "installation" })) as {
        token: string;
      };

      const workflowQuerySnapshot = await getWorkflowQuerySnapshot(
        githubRepositoryUrl
      );

      for (const workflowsDocs of workflowQuerySnapshot.docs) {
        const workflowData = workflowsDocs.data();
        const { baseBranch, platform, workflowName, organizationId } =
          workflowData as WorkflowData;

        const buildNumberObject = await getBuildNumberFromOrganization(
          organizationId
        );
        const iosBuildNumber = buildNumberObject.ios;
        const androidBuildNumber = buildNumberObject.android;

        if (pullRequest.base.ref === baseBranch) {
          const buildNumber =
            platform === "ios" ? iosBuildNumber : androidBuildNumber;
          const branch = context.payload.pull_request.head.ref;
          const baseBranch = context.payload.pull_request.base.ref;

          const _checks = await createChecks(context, workflowName);
          const job = new BuildModel(
            baseBranch,
            branch,
            token,
            githubRepositoryUrl,
            platform,
            workflowsDocs.id
          );
          await firestore
            .collection(jobsCollectionName)
            .doc(job.documentId)
            .set(job.toJSON());

          firestore
            .collection(jobsCollectionName)
            .doc(job.documentId)
            .withConverter(converter)
            .onSnapshot(
              async (
                snapshot: admin.firestore.DocumentSnapshot<BuildModel>
              ) => {
                const buildModel = snapshot.data();
                if (buildModel == undefined) {
                  throw new Error("Build model is undefined");
                }
                const { processing, failure, success } = buildModel.buildStatus;

                if (processing) {
                  await updateCheckStateInProgress(
                    context,
                    _checks,
                    workflowName
                  );
                }
                if (failure) {
                  await updateCheckState(
                    context,
                    _checks,
                    "failure",
                    workflowName
                  );
                }
                if (success) {
                  await updateCheckState(
                    context,
                    _checks,
                    "success",
                    workflowName
                  );

                  await addIssueComment(
                    context,
                    platform,
                    organizationId,
                    buildNumber,
                    workflowName
                  );
                }
              }
            );
        }
      }
    }
  );
};

async function addIssueComment(
  context: Context<"pull_request">,
  platform: string,
  organizationId: string,
  buildNumber: number,
  workflowName: string
) {
  const _issueCommentBody = issueCommentBody(workflowName, buildNumber);
  const issueComment = context.issue({
    body: _issueCommentBody,
  });

  const { data: comments } = await context.octokit.issues.listComments(
    issueComment
  );

  const existingComment = comments.find((comment) =>
    comment.body?.startsWith(issueCommentBodyBase(workflowName))
  );

  if (existingComment) {
    await context.octokit.issues.updateComment({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      comment_id: existingComment.id,
      body: _issueCommentBody,
    });
  } else {
    await context.octokit.issues.createComment(issueComment);
  }

  await updateBuildNumber(platform, organizationId, buildNumber);
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

async function getBuildNumberFromOrganization(organizationId: string) {
  const orgDocs = await firestore
    .collection("organizations")
    .doc(organizationId)
    .get();

  if (!orgDocs.exists) {
    throw new Error(`Organization with ID ${organizationId} does not exist.`);
  }

  const orgData = orgDocs.data();
  if (orgData == undefined) {
    throw new Error("Organization data is undefined");
  }

  const { buildNumber } = orgData;
  return buildNumber;
}

const converter = {
  toFirestore(buildModel: BuildModel): admin.firestore.DocumentData {
    return buildModel.toJSON();
  },
  fromFirestore(snapshot: admin.firestore.QueryDocumentSnapshot): BuildModel {
    const data = snapshot.data() as admin.firestore.DocumentData;
    return BuildModel.fromJSON(data);
  },
};

async function updateCheckStateInProgress(
  context: Context<"pull_request">,
  checks: any,
  name: string
) {
  try {
    return await context.octokit.checks.update({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      name: name,
      check_run_id: checks.data.id,
      status: "in_progress",
    });
  } catch (error) {
    console.error("Failed to create check suite:", error);
    throw error;
  }
}

async function updateCheckState(
  context: Context<"pull_request">,
  checks: any,
  conclusion: any,
  name: string
) {
  try {
    return await context.octokit.checks.update({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      name: name,
      check_run_id: checks.data.id,
      conclusion: conclusion,
      completed_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to create check suite:", error);
    throw error;
  }
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
