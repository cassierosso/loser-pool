/**
 * SS7.3: "Also write the head hash to a LOG_ANCHOR.md file committed to the
 * GitHub repo by the same job, giving a second independent timestamp trail."
 *
 * Behind a port for the same reason the mailer is: the job's obligation is that
 * the anchor gets published somewhere outside the database. Where that is can
 * change without touching the job.
 */
export interface AnchorPublisher {
  readonly name: string;
  /** Current contents, or null when the file does not exist yet. */
  read(path: string): Promise<string | null>;
  write(path: string, contents: string, message: string): Promise<{ location: string }>;
}
