export interface RouteRedirect {
  redirect: string;
}

export interface RouteMatch {
  page: string;
  nav: string;
  crumbs: string[];
  args: (string | undefined)[];
}

export declare function resolveRoute(path: string): RouteRedirect | RouteMatch | null;

export declare function tabHash(section: string, tab: string, arg?: string): string;

export declare function boxHash(id: string, tab?: string, section?: string): string;

export declare function movedBoxHash(hash: string, fromId: string, toId: string): string | null;
