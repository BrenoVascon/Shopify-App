import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async () => {
  throw redirect("/app/additional");
};

export default function Index() {
  return null;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
