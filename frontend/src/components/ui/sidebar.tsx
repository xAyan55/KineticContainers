import * as React from "react";
import { Link as RouterLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";

export interface SidebarLinkItem {
  label: string;
  href: string;
  icon: React.JSX.Element | React.ReactNode;
}

interface SidebarContextProps {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  animate: boolean;
}

const SidebarContext = React.createContext<SidebarContextProps | undefined>(
  undefined
);

export const useSidebar = () => {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
};

export const SidebarProvider = ({
  children,
  open: openProp,
  setOpen: setOpenProp,
  animate = true,
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) => {
  const [openState, setOpenState] = React.useState(false);

  const open = openProp !== undefined ? openProp : openState;
  const setOpen = setOpenProp !== undefined ? setOpenProp : setOpenState;

  return (
    <SidebarContext.Provider value={{ open, setOpen, animate }}>
      {children}
    </SidebarContext.Provider>
  );
};

export const Sidebar = ({
  children,
  open,
  setOpen,
  animate,
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) => {
  return (
    <SidebarProvider open={open} setOpen={setOpen} animate={animate}>
      {children}
    </SidebarProvider>
  );
};

export const SidebarBody = (props: React.ComponentProps<typeof motion.div>) => {
  return (
    <>
      <DesktopSidebar {...props} />
      <MobileSidebar {...(props as React.ComponentProps<"div">)} />
    </>
  );
};

export const DesktopSidebar = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof motion.aside>) => {
  const { open, setOpen, animate } = useSidebar();
  return (
    <motion.aside
      className={cn(
        "h-screen sticky top-0 px-3 py-4 hidden lg:flex lg:flex-col bg-surface border-r border-border shrink-0 z-30 transition-[background-color,border-color]",
        className
      )}
      animate={{
        width: animate ? (open ? "260px" : "64px") : "260px",
      }}
      transition={{ duration: 0.22, ease: "easeInOut" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      {...props}
    >
      {children}
    </motion.aside>
  );
};

export const MobileSidebar = ({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) => {
  const { open, setOpen } = useSidebar();
  return (
    <>
      <div
        className={cn(
          "h-14 px-4 flex flex-row lg:hidden items-center justify-between bg-surface border-b border-border w-full sticky top-0 z-40"
        )}
        {...props}
      >
        <div className="flex justify-end z-20 w-full">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-label="Open navigation"
            className="p-1.5 rounded-md text-muted hover:text-primary hover:bg-raised transition-colors cursor-pointer"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ x: "-100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "-100%", opacity: 0 }}
              transition={{
                duration: 0.25,
                ease: "easeInOut",
              }}
              className={cn(
                "fixed h-full w-72 inset-y-0 left-0 bg-surface border-r border-border p-6 z-[100] flex flex-col justify-between shadow-2xl",
                className
              )}
            >
              <button
                type="button"
                className="absolute right-4 top-4 z-50 text-muted hover:text-primary p-1.5 rounded-md hover:bg-raised transition-colors cursor-pointer"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
              {children}
            </motion.div>
          )}
        </AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[90] lg:hidden"
          />
        )}
      </div>
    </>
  );
};

export const SidebarLink = ({
  link,
  className,
  onClick,
  ...props
}: {
  link: SidebarLinkItem;
  className?: string;
  onClick?: () => void;
  [key: string]: any;
}) => {
  const { open, animate } = useSidebar();
  const isExternal = link.href.startsWith("http") || link.href.startsWith("#");

  const content = (
    <>
      <span className="shrink-0 text-muted group-hover/sidebar:text-primary transition-colors flex items-center justify-center">
        {link.icon}
      </span>
      <motion.span
        animate={{
          display: animate ? (open ? "inline-block" : "none") : "inline-block",
          opacity: animate ? (open ? 1 : 0) : 1,
        }}
        transition={{ duration: 0.15 }}
        className="text-muted group-hover/sidebar:text-primary group-hover/sidebar:translate-x-1 transition duration-150 whitespace-pre inline-block text-sm font-medium !p-0 !m-0 truncate"
      >
        {link.label}
      </motion.span>
    </>
  );

  if (isExternal) {
    return (
      <a
        href={link.href}
        onClick={onClick}
        className={cn(
          "flex items-center justify-start gap-3 group/sidebar py-2 px-2.5 rounded-md hover:bg-raised text-muted hover:text-primary transition-colors",
          className
        )}
        {...props}
      >
        {content}
      </a>
    );
  }

  return (
    <RouterLink
      to={link.href}
      onClick={onClick}
      className={cn(
        "flex items-center justify-start gap-3 group/sidebar py-2 px-2.5 rounded-md hover:bg-raised text-muted hover:text-primary transition-colors",
        className
      )}
      {...props}
    >
      {content}
    </RouterLink>
  );
};
