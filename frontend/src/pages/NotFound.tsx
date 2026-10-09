import { Link } from "react-router-dom";

export function NotFoundPage(): React.JSX.Element {
  return (
    <div className="kct-card mx-auto max-w-md p-8 text-center">
      <p className="text-lg font-semibold text-primary">Page not found</p>
      <p className="mt-1 text-sm text-muted">The requested page does not exist.</p>
      <Link to="/" className="mt-4 inline-block text-sm text-primary underline">Back to dashboard</Link>
    </div>
  );
}
