import { PageSkeleton } from "@/components/Skeleton";

/** Inside the opening's layout: the rail stays, the page area shows its shape. */
export default function Loading() {
  return <PageSkeleton rows={4} wide={false} />;
}
