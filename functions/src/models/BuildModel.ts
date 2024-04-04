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
  };
  readonly createdAt: admin.firestore.FieldValue;
  readonly documentId: string;
  readonly platform: string;
  readonly workflowId: string;

  constructor(
    baseBranch: string,
    buildBranch: string,
    token: string,
    githubRepositoryUrl: string,
    platform: string,
    workflowId: string,
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
    };
    this.createdAt = admin.firestore.FieldValue.serverTimestamp();
    this.documentId = uuidv4();
    this.platform = platform;
    this.workflowId = workflowId;
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
      json.buildStatus
    );
  }
}
