import { clsx } from "clsx";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  disabled,
  children,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={clsx(
        "btn",
        `btn--${variant}`,
        size !== "md" && `btn--${size}`,
        fullWidth && "btn--full",
        className
      )}
      disabled={disabled || loading}
      aria-busy={loading}
      {...props}
    >
      {loading ? <span className="sr-only">Loading…</span> : children}
      {loading && <span aria-hidden="true">…</span>}
    </button>
  );
}
