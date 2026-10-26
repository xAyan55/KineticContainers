import * as React from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Ripple,
  TechOrbitDisplay,
  AnimatedForm,
  type IconConfig,
  type Field,
} from '@/components/ui/modern-animated-sign-in';
import { BrandMark } from '@/components/ui/brand-mark';
import { useBranding } from '@/lib/branding';

import ubuntuImg from '@/assets/os-icons/ubuntu.webp';
import debianImg from '@/assets/os-icons/debian.png';
import archImg from '@/assets/os-icons/arch-linux.webp';
import alpineImg from '@/assets/os-icons/alpine-linux.webp';

export interface KineticModernSignInProps {
  appName: string;
  error?: string;
  loading?: boolean;
  registrationEnabled?: boolean;
  onSubmit: (credentials: { email: string; password: string }) => Promise<void>;
}

export function KineticModernSignIn({
  appName,
  error,
  loading = false,
  registrationEnabled = false,
  onSubmit,
}: KineticModernSignInProps): React.JSX.Element {
  const navigate = useNavigate();
  const { logoUrl } = useBranding();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');

  const osIcons: IconConfig[] = React.useMemo(
    () => [
      {
        component: () => (
          <img
            src={ubuntuImg}
            alt="Ubuntu Linux"
            className="size-8 object-contain drop-shadow-md select-none"
            loading="lazy"
          />
        ),
        className: 'size-[46px] border-border/80 bg-surface/90',
        duration: 22,
        delay: 0,
        radius: 110,
        path: true,
        reverse: false,
      },
      {
        component: () => (
          <img
            src={debianImg}
            alt="Debian Linux"
            className="size-7 object-contain drop-shadow-md select-none"
            loading="lazy"
          />
        ),
        className: 'size-[46px] border-border/80 bg-surface/90',
        duration: 22,
        delay: 11,
        radius: 110,
        path: false,
        reverse: false,
      },
      {
        component: () => (
          <img
            src={archImg}
            alt="Arch Linux"
            className="size-8 object-contain drop-shadow-md select-none"
            loading="lazy"
          />
        ),
        className: 'size-[50px] border-border/80 bg-surface/90',
        duration: 32,
        delay: 0,
        radius: 200,
        path: true,
        reverse: true,
      },
      {
        component: () => (
          <img
            src={alpineImg}
            alt="Alpine Linux"
            className="size-8 object-contain drop-shadow-md select-none"
            loading="lazy"
          />
        ),
        className: 'size-[50px] border-border/80 bg-surface/90',
        duration: 32,
        delay: 16,
        radius: 200,
        path: false,
        reverse: true,
      },
    ],
    []
  );

  const fields: Field[] = React.useMemo(
    () => [
      {
        label: 'Email address',
        required: true,
        type: 'email',
        placeholder: 'operator@example.com',
        value: email,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value),
      },
      {
        label: 'Password',
        required: true,
        type: 'password',
        placeholder: '••••••••',
        value: password,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value),
      },
    ],
    [email, password]
  );

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void onSubmit({ email, password });
  };

  return (
    <div className="min-h-screen w-full flex bg-base text-primary overflow-hidden">
      {/* Left Column: Visual Orbit with Operating System Templates */}
      <div className="relative hidden lg:flex w-1/2 flex-col items-center justify-center border-r border-border bg-base/50 p-12">
        <Ripple mainCircleSize={130} mainCircleOpacity={0.2} numCircles={7} />
        <TechOrbitDisplay
          iconsArray={osIcons}
          text={appName}
          subtext="LXC Infrastructure Platform"
        />
        <div className="absolute bottom-6 left-8 flex items-center gap-2 text-xs font-mono text-muted">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span>Native hardware virtualization & container isolation</span>
        </div>
      </div>

      {/* Right Column: Clean Authentication Form */}
      <div className="flex flex-1 flex-col justify-between px-6 py-10 sm:px-12 lg:px-16 w-full lg:w-1/2">
        <header className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandMark logoUrl={logoUrl} label={`${appName} logo`} />
            <span className="text-sm font-semibold tracking-tight text-logo">
              {appName}
            </span>
          </Link>
          {registrationEnabled && (
            <Link
              to="/register"
              className="text-xs text-muted hover:text-primary transition-colors font-medium"
            >
              Register Account &rarr;
            </Link>
          )}
        </header>

        <main className="my-auto py-10 w-full max-w-sm mx-auto">
          <AnimatedForm
            header="Sign in"
            subHeader="Enter your credentials to access your servers."
            fields={fields}
            submitButton="Sign in to panel"
            errorField={error}
            loading={loading}
            onSubmit={handleFormSubmit}
          />
        </main>

        <footer className="text-center text-xs text-muted">
          <p>{appName} · self-hosted infrastructure panel</p>
        </footer>
      </div>
    </div>
  );
}

export default KineticModernSignIn;
