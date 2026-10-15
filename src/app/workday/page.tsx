import { redirect } from "next/navigation";

export default function WorkdayPage() {
  redirect("/openings?checks=open");
}
