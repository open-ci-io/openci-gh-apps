/* eslint-disable @typescript-eslint/no-explicit-any */
import * as admin from "firebase-admin";
const { v4: uuidv4 } = require("uuid");

export class BuildModel {
  readonly buildStatus: {
    readonly processing: boolean;
    readonly failure: boolean;
    readonly success: boolean;
  };
  readonly branch: {
    readonly baseBranch: string;
    readonly buildBranch: string;
  };
  readonly github: {
    readonly PAT: string;
    readonly repositoryUrl: string;
    readonly issueNumber?: number;
  };
  readonly createdAt: admin.firestore.FieldValue;
  readonly documentId: string;
  readonly platform: string;
  readonly workflowId: string;
  readonly checks: {
    readonly checkRunId: number;
    readonly owner: string;
    readonly repositoryName: string;
    readonly installationId: number;
    readonly jobId: string;
  };

  constructor(
    baseBranch: string,
    buildBranch: string,
    token: string,
    githubRepositoryUrl: string,
    issueNumber: number,
    platform: string,
    workflowId: string,
    checks: {
      checkRunId: number;
      owner: string;
      repositoryName: string;
      installationId: number;
      jobId: string;
    },
    buildStatus?: {
      processing: boolean;
      failure: boolean;
      success: boolean;
    }
  ) {
    this.buildStatus = buildStatus || {
      processing: false,
      failure: false,
      success: false,
    };
    this.branch = {
      baseBranch,
      buildBranch,
    };
    this.github = {
      PAT: token,
      repositoryUrl: githubRepositoryUrl,
      issueNumber: issueNumber,
    };
    this.createdAt = admin.firestore.FieldValue.serverTimestamp();
    this.documentId = uuidv4();
    this.platform = platform;
    this.workflowId = workflowId;
    this.checks = checks;
  }

  toJSON() {
    return {
      buildStatus: this.buildStatus,
      branch: this.branch,
      github: this.github,
      createdAt: this.createdAt,
      documentId: this.documentId,
      platform: this.platform,
      workflowId: this.workflowId,
      checks: this.checks,
    };
  }

  static fromJSON(json: any): BuildModel {
    return new BuildModel(
      json.branch.baseBranch,
      json.branch.buildBranch,
      json.github.PAT,
      json.github.repositoryUrl,
      json.platform,
      json.workflowId,
      json.checks,
      json.buildStatus,
      json.github.issueNumber
    );
  }
}
