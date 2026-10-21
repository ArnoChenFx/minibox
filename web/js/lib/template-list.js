/**
 * The strings a template card is searched by: its name, its tags and reference, its description, its image id, and the
 * badge the card shows. Pure, so the page and the tests share it.
 */
export function templateSearchFields(template, badge) {
  return [template.name, template.ref, ...template.tags, template.description, template.id, badge];
}
