import type { ButtonHTMLAttributes } from "react";

export function Button({ variant = "secondary", className = "", type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" }) {
  return <button type={type} className={`button button--${variant} ${className}`} {...rest} />;
}
