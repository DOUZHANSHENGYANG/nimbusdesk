import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/ahub/lib/utils";

const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover active:bg-primary-hover",
        secondary: "border border-border bg-surface text-foreground hover:bg-surface-2 hover:border-border-strong",
        ghost: "text-ink-2 hover:bg-surface-2 hover:text-foreground",
        outline: "border border-border bg-transparent text-foreground hover:bg-surface-2",
        destructive: "bg-danger text-white shadow-sm hover:opacity-90",
      },
      size: {
        // 高度贴近 Apple 控件：小 28 / 常规 34 / 大 40；仍留出足够点击面积
        sm: "h-7 rounded-md px-2.5 text-xs",
        md: "h-[34px] rounded-md px-3.5 text-[13px]",
        lg: "h-10 rounded-lg px-4 text-sm",
        icon: "h-[34px] w-[34px] rounded-md",
        iconSm: "h-7 w-7 rounded-md",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";

export { buttonVariants };
