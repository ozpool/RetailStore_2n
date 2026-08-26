"use client";

import { useCallback, useEffect, useState } from "react";
import AdminGate, { useAdminGate } from "@/components/admin/AdminGate";
import {
  Card,
  EmptyState,
  Pill,
  TableWrap,
  Td,
  Th,
  Tr,
  fullDate,
} from "@/components/admin/ui";
import { ACTION_LABEL, getAudit, type ModerationAction } from "@/lib/adminApi";

export default function AdminAuditPage() {
  return (
    <AdminGate title="Audit log" subtitle="Every moderation action ever taken">
      {() => <Audit />}
    </AdminGate>
  );
}

/**
 * Append-only, and never edited.
 *
 * Same reasoning as retaining KycAttempt: a decision to remove someone's
 * listing or suspend their account has to be explainable afterwards —
 * including, and especially, when it turns out to have been wrong.
 */
function Audit() {
  const { handleError } = useAdminGate();
  const [actions, setActions] = useState<ModerationAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { actions } = await getAudit();
      setActions(actions);
      setError(null);
    } catch (err) {
      handleError(err);
      setError("Couldn't load the audit log.");
      setActions([]);
    }
  }, [handleError]);

  useEffect(() => {
    load();
  }, [load]);

  const list = actions ?? [];

  const tone = (action: string) =>
    action.endsWith("_REMOVED") || action.endsWith("_SUSPENDED")
      ? "bad"
      : action.endsWith("_RESTORED") || action.endsWith("_REINSTATED")
        ? "good"
        : "neutral";

  return (
    <div className="grid gap-4">
      {/* "Append-only" is the precise term and worth keeping, not just the
          plain-English gloss after it — it names the property that makes the
          log worth anything. */}
      <p className="text-xs text-ink-dim">
        Newest first. This log is append-only: nothing here can be edited or
        removed, including by whoever did it.
      </p>

      {error && (
        <p className="rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">{error}</p>
      )}

      <Card>
        {actions === null ? (
          <p className="px-5 py-14 text-center text-sm text-ink-dim">Loading…</p>
        ) : list.length === 0 ? (
          <EmptyState
            title="Nothing yet"
            body="Nobody has removed a listing or suspended an account."
          />
        ) : (
          <TableWrap>
            <table className="w-full">
              <thead>
                <tr className="bg-blush">
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>Reason</Th>
                  <Th>Moderator</Th>
                  <Th>When</Th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <Tr key={a.id}>
                    <Td>
                      <Pill tone={tone(a.action)}>{ACTION_LABEL[a.action] ?? a.action}</Pill>
                    </Td>
                    <Td>
                      <span className="block max-w-56 truncate">{a.targetLabel}</span>
                      {a.reportId && (
                        <span className="block text-xs text-ink-dim">from a report</span>
                      )}
                    </Td>
                    <Td>
                      <span className="block max-w-80 text-ink-dim">{a.reason}</span>
                    </Td>
                    <Td>
                      <span className="block whitespace-nowrap">{a.moderator}</span>
                      <span className="block truncate text-xs text-ink-dim">
                        {a.moderatorEmail}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap text-ink-dim">{fullDate(a.createdAt)}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
