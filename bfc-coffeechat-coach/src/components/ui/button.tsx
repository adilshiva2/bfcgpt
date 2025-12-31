"use client";

import type { HTMLMotionProps } from "framer-motion";
import { motion } from "framer-motion";

type ButtonVariant = "primary" | "secondary" | "ghost";

type ButtonProps = HTMLMotionProps<"button"> & {
  variant?: ButtonVariant;
};

const baseClasses =
  "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-slate-900 text-white shadow-sm hover:bg-slate-800 focus-visible:outline-slate-900",
  secondary:
    "border border-slate-200 bg-white text-slate-900 shadow-sm hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-slate-900",
  ghost: "text-slate-700 hover:text-slate-900 hover:bg-slate-100 focus-visible:outline-slate-900",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <motion.button
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.98 }}
      className={`${baseClasses} ${variantClasses[variant]} ${className}`}
      {...props}
    />
  );
}
