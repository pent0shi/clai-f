/**
 * `unknown` is a distinct answer from `current`: without a successful check
 * clai must not claim the installation is up to date.
 */
export type UpdateState = "update-available" | "current" | "unknown" | "error";

export interface UpdateStatus {
  readonly state: UpdateState;
  readonly currentVersion: string;
  readonly latestVersion?: string | undefined;
  readonly updateAvailable: boolean;
  /** Why the state is unknown or errored. */
  readonly detail?: string | undefined;
}

export interface UpdatesPort {
  check(): Promise<UpdateStatus>;
}
