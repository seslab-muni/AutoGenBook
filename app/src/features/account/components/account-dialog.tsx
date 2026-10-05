import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import { auth, useClearLlmKeyMutation, useSetLlmKeyMutation } from '@/api/queries/auth';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useUiStore } from '@/stores/ui-store';

/** "Key set, ends in ••••1234, updated 5 Oct 2026" — only ever the last four characters. */
function keyStatusText(llmKey: { last4: string; updatedAt: string } | null | undefined): string {
  if (!llmKey) return 'No key set';
  const updated = new Date(llmKey.updatedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return `Key set, ends in ••••${llmKey.last4}, updated ${updated}`;
}

/**
 * Per-user LLM key (`PUT|DELETE /auth/me/llm-key`): lets the signed-in user store their own
 * API key so their runs get their own parallel-request budget at the gateway instead of sharing
 * the deployment key's. Mounted in the project layout; `AppHeader`'s account menu opens it. The
 * key lives only in this component's state until it is submitted (cleared right after) and is
 * never read back from the API — the status line shows its last four characters at most.
 */
export function AccountDialog() {
  const activeModal = useUiStore((state) => state.activeModal);
  const closeModal = useUiStore((state) => state.closeModal);
  const open = activeModal === 'account';
  const { data: currentUser } = useQuery(auth.me());
  const setMutation = useSetLlmKeyMutation();
  const clearMutation = useClearLlmKeyMutation();
  const [apiKey, setApiKey] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);

  // Never keep a typed secret around across open/close cycles (adjusting state during render,
  // like `ProjectSettingsDialog`'s reset).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setApiKey('');
      setSaveError(null);
      setConfirmRemoveOpen(false);
    }
  }

  const configurable = currentUser?.llmKeyConfigurable === true;
  const policy = currentUser?.llmKeyPolicy ?? 'optional';
  const llmKey = currentUser?.llmKey ?? null;
  const busy = setMutation.isPending || clearMutation.isPending;

  function errorMessage(error: unknown, fallback: string): string {
    const problem = error instanceof ApiError ? error.problem : undefined;
    return problem?.detail ?? problem?.title ?? fallback;
  }

  function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!apiKey.trim()) return;
    setSaveError(null);
    setMutation.mutate(apiKey, {
      onSuccess: () => {
        setApiKey('');
        toast.success('LLM API key saved');
      },
      onError: (error) => {
        // Inline too (not only a toast): the server's 422/409 message is the validation UX here.
        const message = errorMessage(error, 'Could not save the key');
        setSaveError(message);
        toast.error(message);
      },
    });
  }

  function handleRemove() {
    clearMutation.mutate(undefined, {
      onSuccess: () => toast.success('LLM API key removed'),
      onError: (error) => toast.error(errorMessage(error, 'Could not remove the key')),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeModal()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>
            {currentUser ? `${currentUser.displayName} · ${currentUser.email}` : 'Your account'}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSave}>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">Your LLM API key</h3>
            <p id="account-llm-key-help" className="text-xs text-muted-foreground">
              Runs you start use this key instead of the shared one, so they get their own
              parallel-request budget. It is stored encrypted and never shown again.
              {policy === 'required'
                ? ' This deployment requires you to set a key before you can start runs.'
                : ' Without a key your runs use the shared deployment key.'}
            </p>
            <p className="text-sm font-medium text-foreground" data-testid="llm-key-status">
              {keyStatusText(llmKey)}
            </p>
          </div>

          {!configurable ? (
            <p
              id="account-llm-key-disabled"
              role="note"
              className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground"
            >
              Personal LLM keys are not enabled on this deployment (the administrator has not set{' '}
              <code>LLM_KEY_ENCRYPTION_KEY</code>), so all runs use the shared key.
            </p>
          ) : null}

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground" htmlFor="account-llm-key">
              {llmKey ? 'Replace key' : 'API key'}
            </label>
            <Input
              id="account-llm-key"
              type="password"
              // `new-password` + the manager-specific opt-outs: this is an API key, not the
              // login password, so password managers must neither offer to save it as one nor
              // autofill the saved login password into it.
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              spellCheck={false}
              placeholder="sk-…"
              aria-describedby={
                configurable
                  ? 'account-llm-key-help'
                  : 'account-llm-key-help account-llm-key-disabled'
              }
              value={apiKey}
              disabled={!configurable || busy}
              onChange={(event) => {
                setApiKey(event.target.value);
                setSaveError(null);
              }}
            />
          </div>

          {saveError ? (
            <p role="alert" className="text-xs font-medium text-destructive">
              {saveError}
            </p>
          ) : null}

          <DialogFooter>
            {llmKey ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmRemoveOpen(true)}
              >
                {clearMutation.isPending ? 'Removing…' : 'Remove key'}
              </Button>
            ) : null}
            <Button type="submit" disabled={!configurable || busy || !apiKey.trim()}>
              {setMutation.isPending ? 'Saving…' : 'Save key'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>

      <ConfirmDialog
        open={confirmRemoveOpen}
        onOpenChange={setConfirmRemoveOpen}
        title="Remove your LLM API key?"
        description="Your runs will use the shared deployment key instead (or be refused if this deployment requires a personal key)."
        confirmLabel="Confirm remove"
        onConfirm={handleRemove}
      />
    </Dialog>
  );
}
