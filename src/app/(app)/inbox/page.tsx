export default function InboxPage() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold text-foreground">Inbox</h1>
      <p className="max-w-2xl text-sm text-muted">
        The full shared inbox (conversation list, filters, translation toggle, composer) is built in
        Phase 7. This placeholder confirms navigation and role-gated routing work end to end.
      </p>
    </div>
  );
}
