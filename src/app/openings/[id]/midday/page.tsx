import EodPage from "../eod/page";

export default async function MiddayPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mail?: string; msg?: string }>;
}) {
  return EodPage({ params: props.params, searchParams: props.searchParams.then(sp => ({ ...sp, mode: "midday" })) });
}
