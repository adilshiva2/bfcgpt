"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

type AccountMenuProps = {
  email: string;
};

const MAX_BYTES = 1024 * 1024;
const AVATAR_SIZE = 256;

function getStorageKey(email: string) {
  return `bfcgpt_avatar_${email.toLowerCase()}`;
}

function getInitials(email: string) {
  if (!email) return "U";
  const namePart = email.split("@")[0] || "User";
  const parts = namePart.split(/[._-]+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("");
  return initials || "U";
}

async function loadImage(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const img = new window.Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function cropToSquare(img: HTMLImageElement) {
  const size = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - size) / 2;
  const sy = (img.naturalHeight - size) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, sx, sy, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return canvas;
}

export default function AccountMenu({ email }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() => {
    if (typeof window === "undefined" || !email) return null;
    return window.localStorage.getItem(getStorageKey(email));
  });
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hasEmail = Boolean(email);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const handleUploadClick = () => {
    setError(null);
    fileInputRef.current?.click();
  };

  const handleRemove = () => {
    if (!hasEmail) return;
    setAvatarUrl(null);
    window.localStorage.removeItem(getStorageKey(email));
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !hasEmail) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setError("Only PNG or JPG images are allowed.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("Image too large. Max size is 1MB.");
      return;
    }

    setError(null);
    const img = await loadImage(file);
    const canvas = cropToSquare(img);
    if (!canvas) {
      setError("Could not process image.");
      return;
    }
    const dataUrl = canvas.toDataURL(file.type, 0.9);
    window.localStorage.setItem(getStorageKey(email), dataUrl);
    setAvatarUrl(dataUrl);
  };

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="secondary"
        type="button"
        className="border-slate-800 bg-slate-900 text-slate-100"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        Account
      </Button>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-lg"
            role="menu"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-100 text-sm font-semibold text-slate-600">
                {avatarUrl ? (
                  <Image
                    src={avatarUrl}
                    alt="Profile"
                    width={48}
                    height={48}
                    className="h-full w-full object-cover"
                    unoptimized
                  />
                ) : (
                  getInitials(email)
                )}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Signed in as
                </div>
                <div className="mt-1 break-words font-medium text-slate-900">{email}</div>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={handleFileChange}
            />
            <Button
              className="mt-4 w-full"
              variant="secondary"
              onClick={handleUploadClick}
              type="button"
            >
              Upload photo
            </Button>
            {avatarUrl ? (
              <Button
                className="mt-2 w-full"
                variant="ghost"
                onClick={handleRemove}
                type="button"
              >
                Remove photo
              </Button>
            ) : null}
            {error ? <div className="mt-2 text-xs text-red-600">{error}</div> : null}
            <div className="my-3 h-px bg-slate-200" />
            <Button className="w-full" variant="secondary" onClick={() => signOut()} type="button">
              Sign out
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
