/**
 * Client-safe Zod schemas for the sign-in forms. No server-only imports here (this file
 * is imported from a "use client" component).
 */
import { z } from "zod";

export const credentialsSignInSchema = z.object({
  email: z.string().min(1, "Email is required.").email("Enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

export type CredentialsSignInInput = z.infer<typeof credentialsSignInSchema>;

export const magicLinkSignInSchema = z.object({
  email: z.string().min(1, "Email is required.").email("Enter a valid email address."),
});

export type MagicLinkSignInInput = z.infer<typeof magicLinkSignInSchema>;
