import * as React from "react";
import { Sidebar, SidebarBody, SidebarLink } from "@/components/ui/sidebar";
import { LayoutDashboard, UserRound, Settings, LogOut } from "lucide-react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export function SidebarDemo() {
  const links = [
    {
      label: "Dashboard",
      href: "/",
      icon: (
        <LayoutDashboard className="text-muted h-5 w-5 shrink-0" />
      ),
    },
    {
      label: "Profile",
      href: "/profile",
      icon: (
        <UserRound className="text-muted h-5 w-5 shrink-0" />
      ),
    },
    {
      label: "Settings",
      href: "/admin/settings",
      icon: (
        <Settings className="text-muted h-5 w-5 shrink-0" />
      ),
    },
    {
      label: "Logout",
      href: "#logout",
      icon: (
        <LogOut className="text-muted h-5 w-5 shrink-0" />
      ),
    },
  ];
  const [open, setOpen] = React.useState(false);

  return (
    <div
      className={cn(
        "rounded-md flex flex-col md:flex-row bg-base w-full flex-1 max-w-7xl mx-auto border border-border overflow-hidden",
        "h-[60vh]"
      )}
    >
      <Sidebar open={open} setOpen={setOpen}>
        <SidebarBody className="justify-between gap-10">
          <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden">
            {open ? <Logo /> : <LogoIcon />}
            <div className="mt-8 flex flex-col gap-1.5">
              {links.map((link, idx) => (
                <SidebarLink key={idx} link={link} />
              ))}
            </div>
          </div>
          <div className="border-t border-border pt-3">
            <SidebarLink
              link={{
                label: "Admin User",
                href: "/profile",
                icon: (
                  <img
                    src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80"
                    className="h-7 w-7 shrink-0 rounded-full object-cover border border-border"
                    alt="Avatar"
                  />
                ),
              }}
            />
          </div>
        </SidebarBody>
      </Sidebar>
      <div className="flex flex-1 p-6 bg-surface border-l border-border text-primary text-sm font-mono">
        KineticCT Workspace View
      </div>
    </div>
  );
}

export const Logo = () => {
  return (
    <Link
      to="/"
      className="font-normal flex space-x-2 items-center text-sm text-primary py-1 relative z-20"
    >
      <div className="h-5 w-6 bg-primary rounded-br-md rounded-tr-sm rounded-tl-md rounded-bl-sm shrink-0" />
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="font-semibold text-primary whitespace-pre"
      >
        KineticCT
      </motion.span>
    </Link>
  );
};

export const LogoIcon = () => {
  return (
    <Link
      to="/"
      className="font-normal flex space-x-2 items-center text-sm text-primary py-1 relative z-20"
    >
      <div className="h-5 w-6 bg-primary rounded-br-md rounded-tr-sm rounded-tl-md rounded-bl-sm shrink-0" />
    </Link>
  );
};

export default SidebarDemo;
