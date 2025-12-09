import { redirect } from "react-router";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const query = url.searchParams.toString();

  // Preserve incoming params (shop/host) and send direto para o app.
  if (query) {
    throw redirect(`/app/additional?${query}`);
  }

  // Sem params, manda para o app (tela principal) que já lida com auth embutida.
  throw redirect("/app/additional");
};

export default function AppIndexRedirect() {
  return null;
}
