import { micromark } from "micromark";
import { bytes, check } from "./workspace.js";
import { MD_MAX_CURRENT_BYTES, MD_MAX_PREVIEW_BYTES } from "./limits.js";
const escape = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
export function preview(text) {
  check(bytes(text).length <= MD_MAX_CURRENT_BYTES, "MD_LIMIT");
  let token = "MDREVIEWPLACEHOLDER";
  while (text.includes(token)) token += "X";
  const expressions = [];
  const masked = text.replace(/\{\{[^\r\n]*?\}\}|\{%[^\r\n]*?%\}/g, (s) => {
    expressions.push(s);
    return token + (expressions.length - 1) + "END";
  });
  let html = micromark(masked, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
  });
  html = html.replace(
    new RegExp(token + "(\\d+)END", "g"),
    (_, i) => "<code>" + escape(expressions[Number(i)]) + "</code>",
  );
  check(bytes(html).length <= MD_MAX_PREVIEW_BYTES, "MD_LIMIT");
  return html;
}
