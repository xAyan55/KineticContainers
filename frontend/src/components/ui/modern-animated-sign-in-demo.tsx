import * as React from 'react';
import {
  Ripple,
  TechOrbitDisplay,
  AnimatedForm,
  type IconConfig,
} from '@/components/ui/modern-animated-sign-in';

import ubuntuImg from '@/assets/os-icons/ubuntu.webp';
import debianImg from '@/assets/os-icons/debian.png';
import archImg from '@/assets/os-icons/arch-linux.webp';
import alpineImg from '@/assets/os-icons/alpine-linux.webp';

const iconsArray: IconConfig[] = [
  {
    component: () => (
      <img
        src={ubuntuImg}
        alt="Ubuntu"
        className="size-7 object-contain"
      />
    ),
    className: 'size-[44px] border-border bg-surface',
    duration: 20,
    delay: 0,
    radius: 100,
    path: true,
    reverse: false,
  },
  {
    component: () => (
      <img
        src={debianImg}
        alt="Debian"
        className="size-7 object-contain"
      />
    ),
    className: 'size-[44px] border-border bg-surface',
    duration: 20,
    delay: 10,
    radius: 100,
    path: false,
    reverse: false,
  },
  {
    component: () => (
      <img
        src={archImg}
        alt="Arch Linux"
        className="size-8 object-contain"
      />
    ),
    className: 'size-[50px] border-border bg-surface',
    duration: 30,
    delay: 0,
    radius: 180,
    path: true,
    reverse: true,
  },
  {
    component: () => (
      <img
        src={alpineImg}
        alt="Alpine Linux"
        className="size-8 object-contain"
      />
    ),
    className: 'size-[50px] border-border bg-surface',
    duration: 30,
    delay: 15,
    radius: 180,
    path: false,
    reverse: true,
  },
];

export function ModernAnimatedSignInDemo() {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');

  const formFields = {
    header: 'Sign in',
    subHeader: 'Enter your credentials to access the console',
    fields: [
      {
        label: 'Email',
        required: true,
        type: 'email' as const,
        placeholder: 'operator@example.com',
        value: email,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value),
      },
      {
        label: 'Password',
        required: true,
        type: 'password' as const,
        placeholder: '••••••••',
        value: password,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value),
      },
    ],
    submitButton: 'Sign in',
  };

  return (
    <section className="flex min-h-screen bg-base text-primary">
      {/* Left Side */}
      <div className="relative hidden lg:flex w-1/2 flex-col justify-center items-center border-r border-border p-8">
        <Ripple mainCircleSize={120} />
        <TechOrbitDisplay iconsArray={iconsArray} text="KineticCT" subtext="Operating System Templates" />
      </div>

      {/* Right Side */}
      <div className="w-full lg:w-1/2 flex flex-col justify-center items-center px-6 py-12">
        <div className="w-full max-w-sm">
          <AnimatedForm
            {...formFields}
            onSubmit={(e) => {
              e.preventDefault();
              console.log('Sign in submitted', { email, password });
            }}
          />
        </div>
      </div>
    </section>
  );
}

export default ModernAnimatedSignInDemo;
