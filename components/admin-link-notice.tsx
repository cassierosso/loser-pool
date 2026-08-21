import { pendingAdminLinkNotice } from "@/lib/auth/service";
import { getDatabase } from "@/lib/db/client";
import { formatKickoff } from "@/lib/time";

/**
 * SS7 -- telling a member that an admin minted a sign-in link for their account
 * and that it was used.
 *
 * The pairing with the log is what makes the feature safe enough to exist. An
 * admin who mints a link "for Dave" and walks through it themselves leaves two
 * public entries AND this notice on Dave's screen -- and Dave knows perfectly
 * well whether he signed in that day.
 */
export async function AdminLinkNotice({ userId }: { userId: string }) {
  const { db } = await getDatabase();
  const notice = await pendingAdminLinkNotice(db, userId);
  if (!notice) return null;

  return (
    <section className="rounded-xl border-2 border-amber-500 bg-amber-950/60 px-4 py-3">
      <h2 className="text-sm font-semibold text-amber-100">
        A sign-in link was created for your account
      </h2>
      <p className="mt-1 text-sm text-amber-200/90">
        {notice.adminName ?? "An admin"} created a sign-in link for your account on{" "}
        {formatKickoff(notice.createdAt)}, and it has been used. If that was you signing in, nothing
        is wrong. <strong className="text-amber-100">If it wasn&apos;t, say so</strong> — it means
        someone else has been in your account. Both events are in the League Log.
      </p>
    </section>
  );
}
