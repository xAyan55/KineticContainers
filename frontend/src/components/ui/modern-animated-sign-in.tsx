import * as React from 'react';
import {
  motion,
  useAnimation,
  useInView,
  useMotionTemplate,
  useMotionValue,
} from 'framer-motion';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';

// ==================== Input Component ====================

const Input = React.memo(
  React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    function Input({ className, type, ...props }, ref) {
      const radius = 100;
      const [visible, setVisible] = React.useState(false);

      const mouseX = useMotionValue(0);
      const mouseY = useMotionValue(0);

      function handleMouseMove({
        currentTarget,
        clientX,
        clientY,
      }: React.MouseEvent<HTMLDivElement>) {
        const { left, top } = currentTarget.getBoundingClientRect();
        mouseX.set(clientX - left);
        mouseY.set(clientY - top);
      }

      return (
        <motion.div
          style={{
            background: useMotionTemplate`
              radial-gradient(
                ${visible ? radius + 'px' : '0px'} circle at ${mouseX}px ${mouseY}px,
                rgba(245, 245, 245, 0.15),
                transparent 80%
              )
            `,
          }}
          onMouseMove={handleMouseMove}
          onMouseEnter={() => setVisible(true)}
          onMouseLeave={() => setVisible(false)}
          className="group/input rounded-md p-[1px] transition duration-300"
        >
          <input
            type={type}
            className={cn(
              "flex h-10 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-primary transition duration-200 placeholder:text-muted focus-visible:border-highlight focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
              className
            )}
            ref={ref}
            {...props}
          />
        </motion.div>
      );
    }
  )
);

Input.displayName = 'Input';

// ==================== BoxReveal Component ====================

export type BoxRevealProps = {
  children: React.ReactNode;
  width?: string;
  boxColor?: string;
  duration?: number;
  overflow?: string;
  position?: string;
  className?: string;
};

const BoxReveal = React.memo(function BoxReveal({
  children,
  width = 'fit-content',
  boxColor,
  duration,
  overflow = 'hidden',
  position = 'relative',
  className,
}: BoxRevealProps) {
  const mainControls = useAnimation();
  const slideControls = useAnimation();
  const ref = React.useRef(null);
  const isInView = useInView(ref, { once: true });

  React.useEffect(() => {
    if (isInView) {
      slideControls.start('visible');
      mainControls.start('visible');
    } else {
      slideControls.start('hidden');
      mainControls.start('hidden');
    }
  }, [isInView, mainControls, slideControls]);

  return (
    <div
      ref={ref}
      style={{
        position: position as any,
        width,
        overflow,
      }}
      className={className}
    >
      <motion.div
        variants={{
          hidden: { opacity: 0, y: 75 },
          visible: { opacity: 1, y: 0 },
        }}
        initial="hidden"
        animate={mainControls}
        transition={{ duration: duration ?? 0.5, delay: 0.25 }}
      >
        {children}
      </motion.div>
      <motion.div
        variants={{ hidden: { left: 0 }, visible: { left: '100%' } }}
        initial="hidden"
        animate={slideControls}
        transition={{ duration: duration ?? 0.5, ease: 'easeIn' }}
        style={{
          position: 'absolute',
          top: 4,
          bottom: 4,
          left: 0,
          right: 0,
          zIndex: 20,
          background: boxColor ?? 'var(--skeleton, #303030)',
          borderRadius: 4,
        }}
      />
    </div>
  );
});

// ==================== Ripple Component ====================

export type RippleProps = {
  mainCircleSize?: number;
  mainCircleOpacity?: number;
  numCircles?: number;
  className?: string;
};

const Ripple = React.memo(function Ripple({
  mainCircleSize = 210,
  mainCircleOpacity = 0.24,
  numCircles = 8,
  className = '',
}: RippleProps) {
  return (
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-center [mask-image:linear-gradient(to_bottom,white,transparent)] pointer-events-none",
        className
      )}
    >
      {Array.from({ length: numCircles }, (_, i) => {
        const size = mainCircleSize + i * 65;
        const opacity = Math.max(0.04, mainCircleOpacity - i * 0.03);
        const animationDelay = `${i * 0.06}s`;
        const borderStyle = i === numCircles - 1 ? 'dashed' : 'solid';

        return (
          <span
            key={i}
            className="absolute animate-ripple rounded-full border border-border"
            style={{
              width: `${size}px`,
              height: `${size}px`,
              opacity: opacity,
              animationDelay: animationDelay,
              borderStyle: borderStyle,
              borderWidth: '1px',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
            }}
          />
        );
      })}
    </div>
  );
});

// ==================== OrbitingCircles Component ====================

export type OrbitingCirclesProps = {
  className?: string;
  children: React.ReactNode;
  reverse?: boolean;
  duration?: number;
  delay?: number;
  radius?: number;
  path?: boolean;
};

const OrbitingCircles = React.memo(function OrbitingCircles({
  className,
  children,
  reverse = false,
  duration = 20,
  delay = 10,
  radius = 50,
  path = true,
}: OrbitingCirclesProps) {
  return (
    <>
      {path && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          version="1.1"
          className="pointer-events-none absolute inset-0 size-full"
        >
          <circle
            className="stroke-border stroke-1"
            cx="50%"
            cy="50%"
            r={radius}
            fill="none"
          />
        </svg>
      )}
      <div
        style={
          {
            '--duration': duration,
            '--radius': radius,
            '--delay': -delay,
          } as React.CSSProperties
        }
        className={cn(
          'absolute flex size-full transform-gpu animate-orbit items-center justify-center rounded-full border border-border/40 bg-surface/80 [animation-delay:calc(var(--delay)*1000ms)] shadow-sm backdrop-blur-xs',
          { '[animation-direction:reverse]': reverse },
          className
        )}
      >
        {children}
      </div>
    </>
  );
});

// ==================== TechOrbitDisplay Component ====================

export type IconConfig = {
  className?: string;
  duration?: number;
  delay?: number;
  radius?: number;
  path?: boolean;
  reverse?: boolean;
  component: () => React.ReactNode;
};

export type TechnologyOrbitDisplayProps = {
  iconsArray: IconConfig[];
  text?: string;
  subtext?: string;
};

const TechOrbitDisplay = React.memo(function TechOrbitDisplay({
  iconsArray,
  text = 'KineticCT',
  subtext = 'LXC Container Engine',
}: TechnologyOrbitDisplayProps) {
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-lg select-none">
      <div className="z-10 flex flex-col items-center justify-center text-center px-4">
        <span className="pointer-events-none whitespace-pre-wrap bg-gradient-to-b from-primary via-primary/90 to-muted bg-clip-text text-center text-5xl sm:text-6xl font-bold tracking-tight text-transparent">
          {text}
        </span>
        {subtext && (
          <span className="mt-2 text-xs font-mono tracking-widest uppercase text-muted">
            {subtext}
          </span>
        )}
      </div>

      {iconsArray.map((icon, index) => (
        <OrbitingCircles
          key={index}
          className={icon.className}
          duration={icon.duration}
          delay={icon.delay}
          radius={icon.radius}
          path={icon.path}
          reverse={icon.reverse}
        >
          {icon.component()}
        </OrbitingCircles>
      ))}
    </div>
  );
});

// ==================== AnimatedForm Component ====================

export type FieldType = 'text' | 'email' | 'password';

export type Field = {
  label: string;
  required?: boolean;
  type: FieldType;
  placeholder?: string;
  value?: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

export type AnimatedFormProps = {
  header: string;
  subHeader?: string;
  fields: Field[];
  submitButton: string;
  textVariantButton?: string;
  errorField?: string;
  loading?: boolean;
  fieldPerRow?: number;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  goTo?: (event: React.MouseEvent<HTMLButtonElement>) => void;
};

type Errors = {
  [key: string]: string;
};

const AnimatedForm = React.memo(function AnimatedForm({
  header,
  subHeader,
  fields,
  submitButton,
  textVariantButton,
  errorField,
  loading = false,
  fieldPerRow = 1,
  onSubmit,
  goTo,
}: AnimatedFormProps) {
  const [visible, setVisible] = React.useState<boolean>(false);
  const [errors, setErrors] = React.useState<Errors>({});

  const toggleVisibility = () => setVisible(!visible);

  const validateForm = (event: React.FormEvent<HTMLFormElement>) => {
    const currentErrors: Errors = {};
    fields.forEach((field) => {
      const inputEl = (event.currentTarget.elements.namedItem(field.label) as HTMLInputElement) || null;
      const val = inputEl ? inputEl.value : field.value || '';

      if (field.required && !val.trim()) {
        currentErrors[field.label] = `${field.label} is required`;
      } else if (field.type === 'email' && val && !/\S+@\S+\.\S+/.test(val)) {
        currentErrors[field.label] = 'Invalid email address';
      }
    });
    return currentErrors;
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formErrors = validateForm(event);

    if (Object.keys(formErrors).length === 0) {
      setErrors({});
      onSubmit(event);
    } else {
      setErrors(formErrors);
    }
  };

  return (
    <div className="flex flex-col gap-4 w-full max-w-sm mx-auto">
      <BoxReveal boxColor="var(--skeleton, #303030)" duration={0.3}>
        <h2 className="font-semibold text-2xl sm:text-3xl tracking-tight text-primary">
          {header}
        </h2>
      </BoxReveal>

      {subHeader && (
        <BoxReveal boxColor="var(--skeleton, #303030)" duration={0.3} className="pb-2">
          <p className="text-muted text-sm max-w-sm">
            {subHeader}
          </p>
        </BoxReveal>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div className={`grid grid-cols-1 md:grid-cols-${fieldPerRow} gap-4 mb-4`}>
          {fields.map((field) => (
            <div key={field.label} className="flex flex-col gap-1.5">
              <BoxReveal boxColor="var(--skeleton, #303030)" duration={0.3}>
                <Label htmlFor={field.label}>
                  {field.label} {field.required && <span className="text-muted text-xs">*</span>}
                </Label>
              </BoxReveal>

              <BoxReveal
                width="100%"
                boxColor="var(--skeleton, #303030)"
                duration={0.3}
                className="flex flex-col space-y-1 w-full"
              >
                <div className="relative">
                  <Input
                    type={
                      field.type === 'password'
                        ? visible
                          ? 'text'
                          : 'password'
                        : field.type
                    }
                    id={field.label}
                    name={field.label}
                    placeholder={field.placeholder}
                    value={field.value}
                    onChange={field.onChange}
                    disabled={loading}
                    autoComplete={field.type === 'password' ? 'current-password' : 'email'}
                  />

                  {field.type === 'password' && (
                    <button
                      type="button"
                      onClick={toggleVisibility}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted hover:text-primary transition-colors cursor-pointer"
                      tabIndex={-1}
                      aria-label={visible ? 'Hide password' : 'Show password'}
                    >
                      {visible ? (
                        <Eye className="h-4 w-4" />
                      ) : (
                        <EyeOff className="h-4 w-4" />
                      )}
                    </button>
                  )}
                </div>

                {errors[field.label] && (
                  <p className="text-rose-400 text-xs font-mono pt-1">
                    {errors[field.label]}
                  </p>
                )}
              </BoxReveal>
            </div>
          ))}
        </div>

        {errorField && (
          <BoxReveal width="100%" boxColor="var(--skeleton, #303030)" duration={0.3}>
            <div className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
              {errorField}
            </div>
          </BoxReveal>
        )}

        <BoxReveal
          width="100%"
          boxColor="var(--skeleton, #303030)"
          duration={0.3}
          overflow="visible"
        >
          <button
            className="kct-btn-primary w-full relative group/btn h-10 font-medium cursor-pointer transition-all duration-200 disabled:opacity-60"
            type="submit"
            disabled={loading}
          >
            {loading ? "Authenticating…" : submitButton} &rarr;
            <BottomGradient />
          </button>
        </BoxReveal>

        {textVariantButton && goTo && (
          <BoxReveal boxColor="var(--skeleton, #303030)" duration={0.3}>
            <div className="mt-4 text-center">
              <button
                type="button"
                className="text-xs text-muted hover:text-primary transition-colors cursor-pointer"
                onClick={goTo}
              >
                {textVariantButton}
              </button>
            </div>
          </BoxReveal>
        )}
      </form>
    </div>
  );
});

const BottomGradient = () => {
  return (
    <>
      <span className="group-hover/btn:opacity-100 block transition duration-500 opacity-0 absolute h-[2px] w-full -bottom-px inset-x-0 bg-gradient-to-r from-transparent via-primary to-transparent" />
      <span className="group-hover/btn:opacity-100 blur-xs block transition duration-500 opacity-0 absolute h-[2px] w-1/2 mx-auto -bottom-px inset-x-10 bg-gradient-to-r from-transparent via-highlight to-transparent" />
    </>
  );
};

// ==================== AuthTabs Component ====================

export interface AuthTabsProps {
  formFields: {
    header: string;
    subHeader?: string;
    fields: Field[];
    submitButton: string;
    textVariantButton?: string;
    errorField?: string;
    loading?: boolean;
  };
  goTo?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  handleSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

const AuthTabs = React.memo(function AuthTabs({
  formFields,
  goTo,
  handleSubmit,
}: AuthTabsProps) {
  return (
    <div className="flex w-full justify-center items-center">
      <AnimatedForm
        {...formFields}
        fieldPerRow={1}
        onSubmit={handleSubmit}
        goTo={goTo}
      />
    </div>
  );
});

// ==================== Label Component ====================

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  htmlFor?: string;
}

const Label = React.memo(function Label({ className, ...props }: LabelProps) {
  return (
    <label
      className={cn(
        'text-xs font-medium text-primary block',
        className
      )}
      {...props}
    />
  );
});

// ==================== Exports ====================

export {
  Input,
  BoxReveal,
  Ripple,
  OrbitingCircles,
  TechOrbitDisplay,
  AnimatedForm,
  AuthTabs,
  Label,
  BottomGradient,
};
