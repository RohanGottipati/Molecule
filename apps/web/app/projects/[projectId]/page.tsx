import { OrderWorkspace } from "../../../components/OrderWorkspace";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <OrderWorkspace initialOrderId={projectId} />;
}
