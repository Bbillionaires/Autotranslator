"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { credentialsSignInSchema, magicLinkSignInSchema } from "@/lib/schemas/auth";

type FieldErrors = Record<string, string>;

export default function SignInPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [magicLinkMode, setMagicLinkMode] = useState(false);
  const [magicLinkEmail, setMagicLinkEmail] = useState("");
  const [magicLinkStatus, setMagicLinkStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const [isSendingMagicLink, setIsSendingMagicLink] = useState(false);

  async function handleCredentialsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = credentialsSignInSchema.safeParse({ email, password });
    if (!parsed.success) {
      const nextErrors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        nextErrors[String(issue.path[0])] = issue.message;
      }
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setIsSubmitting(true);

    try {
      const result = await signIn("credentials", {
        email: parsed.data.email,
        password: parsed.data.password,
        redirect: false,
      });

      if (!result || result.error) {
        setFormError("Invalid email or password. Please try again.");
        return;
      }

      router.push("/inbox");
      router.refresh();
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleMagicLinkSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMagicLinkStatus(null);

    const parsed = magicLinkSignInSchema.safeParse({ email: magicLinkEmail });
    if (!parsed.success) {
      setMagicLinkStatus({
        kind: "error",
        message: parsed.error.issues[0]?.message ?? "Invalid email.",
      });
      return;
    }

    setIsSendingMagicLink(true);
    try {
      await signIn("email", {
        email: parsed.data.email,
        redirect: false,
        callbackUrl: "/inbox",
      });
      setMagicLinkStatus({
        kind: "success",
        message:
          "If an account exists for that email, a sign-in link was generated. In local development, check the server console/logs for the link (no real email is sent).",
      });
    } catch {
      setMagicLinkStatus({ kind: "error", message: "Something went wrong. Please try again." });
    } finally {
      setIsSendingMagicLink(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Use your AutoTranslator account credentials.</p>
      </div>

      {!magicLinkMode ? (
        <form className="flex flex-col gap-4" onSubmit={handleCredentialsSubmit} noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-sm font-medium text-foreground">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? "email-error" : undefined}
            />
            {errors.email ? (
              <p id="email-error" className="text-xs text-danger">
                {errors.email}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "password-error" : undefined}
            />
            {errors.password ? (
              <p id="password-error" className="text-xs text-danger">
                {errors.password}
              </p>
            ) : null}
          </div>

          {formError ? (
            <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-opacity disabled:opacity-60"
          >
            {isSubmitting ? "Signing in…" : "Sign in"}
          </button>

          <button
            type="button"
            onClick={() => setMagicLinkMode(true)}
            className="text-sm text-muted underline-offset-2 hover:underline"
          >
            Sign in with a magic link instead
          </button>
        </form>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={handleMagicLinkSubmit} noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="magic-email" className="text-sm font-medium text-foreground">
              Email
            </label>
            <input
              id="magic-email"
              name="email"
              type="email"
              autoComplete="email"
              value={magicLinkEmail}
              onChange={(e) => setMagicLinkEmail(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
            />
          </div>

          {magicLinkStatus ? (
            <p
              role="status"
              className={
                magicLinkStatus.kind === "success"
                  ? "rounded-md bg-success/10 px-3 py-2 text-sm text-success"
                  : "rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
              }
            >
              {magicLinkStatus.message}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={isSendingMagicLink}
            className="mt-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-opacity disabled:opacity-60"
          >
            {isSendingMagicLink ? "Sending…" : "Send magic link"}
          </button>

          <button
            type="button"
            onClick={() => setMagicLinkMode(false)}
            className="text-sm text-muted underline-offset-2 hover:underline"
          >
            Back to password sign-in
          </button>
        </form>
      )}
    </div>
  );
}
