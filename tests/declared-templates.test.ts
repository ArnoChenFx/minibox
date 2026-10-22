import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { RuntimeError, type HelperSpec } from "../src/runtime";
import {
  createDeclaredTemplate,
  declaredTemplate,
  readRecipe,
  rebuildDeclaredTemplate,
  type TemplateSource,
} from "../src/services/template-builds";
import { listTemplates, deleteTemplate } from "../src/services/templates";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { archive, entry, tarBytes } from "./support/tar";

let restoreLogs: () => void;
beforeEach(() => {
  restoreLogs = silenceLogs();
});
afterEach(() => restoreLogs());

interface Lab {
  readonly app: App;
  readonly runtime: FakeRuntime;
  readonly host: HostCtx;
  /** The files a clone brings in, by repository path. Edit it between builds to model a new commit. */
  readonly repo: Map<string, string>;
  readonly progress: string[];
}

/**
 * An app with its base template seeded. A clone helper writes `repo` into the volume it is given, the way a real clone
 * leaves the repository there. Every other helper run answers as the default does.
 */
function lab(): Lab {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
  const repo = new Map<string, string>();
  runtime.helperHandler = (spec: HelperSpec) => {
    if (spec.cmd[0] === "sh") {
      const volume = spec.mounts?.[0]?.source ?? "";
      for (const [path, text] of repo) {
        runtime.seedVolumeFile(volume, path, { type: "file", content: Buffer.from(text) });
      }
      return { exitCode: 0, logs: "" };
    }
    return { exitCode: 0, logs: "" };
  };
  return { app, runtime, host, repo, progress: [] };
}

const progressOf = (l: Lab) => ({ log: (text: string) => l.progress.push(text) });

const FROM_ALPINE = "FROM alpine:3.20\nRUN true\n";

describe("a template built from a pasted Dockerfile", () => {
  test("builds the text as the Dockerfile, labels the image, and records how it was built", async () => {
    const l = lab();
    const source: TemplateSource = { kind: "dockerfile", text: FROM_ALPINE };

    const created = await createDeclaredTemplate(l.host, { name: "tool", source, createdBy: "owner" }, progressOf(l));

    expect(created).toEqual({ ref: "mbtest-template:tool", name: "tool" });
    const [build] = l.runtime.builds;
    expect(build).toMatchObject({ tag: "mbtest-template:tool", dockerfile: "Dockerfile", args: {} });
    expect(build?.files.get("Dockerfile")).toBe(FROM_ALPINE);
    expect((await l.runtime.inspectImage("mbtest-template:tool")).labels).toMatchObject({
      [l.host.keys.template]: "true",
      [l.host.keys.templateName]: "tool",
      [l.host.keys.templateDesc]: "Built from a Dockerfile",
      [l.host.keys.createdBy]: "owner",
    });
    const recipe = readRecipe(l.host, "tool");
    expect(recipe).toMatchObject({ version: 1, description: null, createdBy: "owner", source });
    expect(recipe?.imageId).toBe((await l.runtime.inspectImage("mbtest-template:tool")).id);
  });

  test("the engine's build output reaches the progress log", async () => {
    const l = lab();
    await createDeclaredTemplate(
      l.host,
      { name: "tool", source: { kind: "dockerfile", text: FROM_ALPINE }, createdBy: "owner" },
      progressOf(l),
    );
    expect(l.progress.join("")).toContain("Successfully built");
  });

  test("the template lists with its build kind, and a saved template does not", async () => {
    const l = lab();
    await createDeclaredTemplate(
      l.host,
      { name: "tool", source: { kind: "dockerfile", text: FROM_ALPINE }, createdBy: "owner" },
      progressOf(l),
    );
    l.runtime.seedImage("mbtest-template:saved", {
      [l.host.keys.template]: "true",
      [l.host.keys.templateName]: "saved",
    });

    const listed = await listTemplates(l.host);

    expect(listed.find((t) => t.name === "tool")).toMatchObject({
      ref: "mbtest-template:tool",
      buildKind: "dockerfile",
    });
    expect(listed.find((t) => t.name === "saved")).not.toHaveProperty("buildKind");
  });

  test("a Dockerfile without FROM is refused before the engine is asked to build", async () => {
    const l = lab();
    const error = await rejectionOf(
      createDeclaredTemplate(
        l.host,
        { name: "bad", source: { kind: "dockerfile", text: "RUN true\n" }, createdBy: "owner" },
        progressOf(l),
      ),
    );
    expect(error).toMatchObject({ status: 400, key: "dockerfile_invalid" });
    expect(l.runtime.builds).toEqual([]);
    expect(readRecipe(l.host, "bad")).toBeNull();
  });

  test("a failed build leaves neither an image nor a recipe, so the name is free to try again", async () => {
    const l = lab();
    l.runtime.fail("buildImage", new RuntimeError("engine", "build step 2 failed"));

    const error = await rejectionOf(
      createDeclaredTemplate(
        l.host,
        { name: "tool", source: { kind: "dockerfile", text: FROM_ALPINE }, createdBy: "owner" },
        progressOf(l),
      ),
    );

    expect(error).toBeInstanceOf(RuntimeError);
    expect(await l.runtime.listImages({ labels: { [l.host.keys.template]: "true" } })).toHaveLength(1);
    expect(readRecipe(l.host, "tool")).toBeNull();
  });

  test("the description given is kept, and a template gets its own default otherwise", async () => {
    const l = lab();
    await createDeclaredTemplate(
      l.host,
      {
        name: "tool",
        description: "Rust toolchain",
        source: { kind: "dockerfile", text: FROM_ALPINE },
        createdBy: "owner",
      },
      progressOf(l),
    );
    expect((await l.runtime.inspectImage("mbtest-template:tool")).labels[l.host.keys.templateDesc]).toBe(
      "Rust toolchain",
    );
    expect(readRecipe(l.host, "tool")?.description).toBe("Rust toolchain");
  });

  test("deleting the template removes its recipe", async () => {
    const l = lab();
    await createDeclaredTemplate(
      l.host,
      { name: "tool", source: { kind: "dockerfile", text: FROM_ALPINE }, createdBy: "owner" },
      progressOf(l),
    );

    await deleteTemplate(l.host, "mbtest-template:tool");

    expect(readRecipe(l.host, "tool")).toBeNull();
  });
});

describe("rebuilding a declared template", () => {
  test("a successful rebuild moves the tag to the new image and records it in the recipe", async () => {
    const l = lab();
    await createDeclaredTemplate(
      l.host,
      { name: "tool", source: { kind: "dockerfile", text: FROM_ALPINE }, createdBy: "owner" },
      progressOf(l),
    );
    const before = (await l.runtime.inspectImage("mbtest-template:tool")).id;
    const declared = await declaredTemplate(l.host, "mbtest-template:tool");

    await rebuildDeclaredTemplate(l.host, declared, progressOf(l));

    const after = (await l.runtime.inspectImage("mbtest-template:tool")).id;
    expect(after).not.toBe(before);
    expect(readRecipe(l.host, "tool")?.imageId).toBe(after);
    expect(l.runtime.builds).toHaveLength(2);
  });

  test("a failed rebuild keeps the image the template had and its recipe", async () => {
    const l = lab();
    await createDeclaredTemplate(
      l.host,
      { name: "tool", source: { kind: "dockerfile", text: FROM_ALPINE }, createdBy: "owner" },
      progressOf(l),
    );
    const before = (await l.runtime.inspectImage("mbtest-template:tool")).id;
    const declared = await declaredTemplate(l.host, "mbtest-template:tool");
    l.runtime.fail("buildImage", new RuntimeError("engine", "network went away"));

    await expect(rebuildDeclaredTemplate(l.host, declared, progressOf(l))).rejects.toBeInstanceOf(RuntimeError);

    expect((await l.runtime.inspectImage("mbtest-template:tool")).id).toBe(before);
    expect(readRecipe(l.host, "tool")?.imageId).toBe(before);
  });

  test("a template whose image a saved image replaced is refused: only a recipe's own image is declared", async () => {
    const l = lab();
    await createDeclaredTemplate(
      l.host,
      { name: "tool", source: { kind: "dockerfile", text: FROM_ALPINE }, createdBy: "owner" },
      progressOf(l),
    );
    l.runtime.moveTag("mbtest-template:tool", { [l.host.keys.template]: "true", [l.host.keys.templateName]: "tool" });

    const error = await rejectionOf(declaredTemplate(l.host, "mbtest-template:tool"));

    expect(error).toMatchObject({ status: 400, key: "template_not_declared" });
  });

  test("a name with no template image is not found, and so is a template a recipe did not build", async () => {
    const l = lab();
    expect(await rejectionOf(declaredTemplate(l.host, "mbtest-template:none"))).toMatchObject({ status: 404 });
    l.runtime.seedImage("mbtest-template:saved", {
      [l.host.keys.template]: "true",
      [l.host.keys.templateName]: "saved",
    });
    expect(await rejectionOf(declaredTemplate(l.host, "mbtest-template:saved"))).toMatchObject({
      key: "template_not_declared",
    });
  });
});

describe("a template built from a Git repository", () => {
  test("clones the repository, builds the Dockerfile in the subdirectory, and keeps out the .git directory", async () => {
    const l = lab();
    l.repo.set("app/Dockerfile", "FROM alpine:3.20\nRUN echo app\n");
    l.repo.set("app/notes.txt", "notes");
    l.repo.set(".git/config", "[core]\n");
    const source: TemplateSource = {
      kind: "git",
      url: "https://github.com/org/app.git",
      branch: "main",
      subdir: "app",
    };

    await createDeclaredTemplate(l.host, { name: "app", source, createdBy: "owner" }, progressOf(l));

    const [build] = l.runtime.builds;
    expect(build?.dockerfile).toBe("Dockerfile");
    expect(build?.files.get("Dockerfile")).toBe("FROM alpine:3.20\nRUN echo app\n");
    expect(build?.files.has("notes.txt")).toBe(true);
    expect([...(build?.files.keys() ?? [])].some((path) => path.startsWith(".git"))).toBe(false);
    expect((await l.runtime.inspectImage("mbtest-template:app")).labels[l.host.keys.templateDesc]).toBe(
      "Built from https://github.com/org/app.git (main)",
    );
    expect(l.progress.join("")).toContain("Cloning https://github.com/org/app.git");
  });

  test("a rebuild clones again, so the template takes the newest commit", async () => {
    const l = lab();
    l.repo.set("Dockerfile", "FROM alpine:3.20\nENV VERSION=1\n");
    await createDeclaredTemplate(
      l.host,
      { name: "app", source: { kind: "git", url: "https://github.com/org/app.git" }, createdBy: "owner" },
      progressOf(l),
    );

    l.repo.set("Dockerfile", "FROM alpine:3.20\nENV VERSION=2\n");
    await rebuildDeclaredTemplate(l.host, await declaredTemplate(l.host, "mbtest-template:app"), progressOf(l));

    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toContain("VERSION=2");
  });

  test("a Dockerfile the repository does not have is refused by name", async () => {
    const l = lab();
    l.repo.set("README.md", "hi");
    const error = await rejectionOf(
      createDeclaredTemplate(
        l.host,
        {
          name: "app",
          source: { kind: "git", url: "https://github.com/org/app.git", dockerfile: "docker/Dockerfile" },
          createdBy: "owner",
        },
        progressOf(l),
      ),
    );
    expect(error).toMatchObject({ status: 400, key: "dockerfile_not_found" });
    expect(l.runtime.builds).toEqual([]);
  });

  test("a Dockerfile path that climbs out of the repository is refused as an invalid path", async () => {
    const l = lab();
    const error = await rejectionOf(
      createDeclaredTemplate(
        l.host,
        {
          name: "app",
          source: { kind: "git", url: "https://github.com/org/app.git", dockerfile: "../Dockerfile" },
          createdBy: "owner",
        },
        progressOf(l),
      ),
    );
    expect(error).toMatchObject({ status: 400 });
    expect(l.runtime.builds).toEqual([]);
  });
});

describe("a template built from a devcontainer.json", () => {
  test("an image becomes the FROM of a Dockerfile with the containerEnv as ENV lines", async () => {
    const l = lab();
    l.repo.set(
      ".devcontainer/devcontainer.json",
      '{\n  // the image\n  "image": "alpine:3.20",\n  "containerEnv": { "PATH_HINT": "a\\\\b" },\n}\n',
    );

    await createDeclaredTemplate(
      l.host,
      { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
      progressOf(l),
    );

    const build = l.runtime.builds.at(-1);
    expect(build?.files.get("Dockerfile")).toBe('FROM alpine:3.20\nENV PATH_HINT="a\\\\b"\n');
    expect((await l.runtime.inspectImage("mbtest-template:dev")).labels[l.host.keys.templateDesc]).toBe(
      "Built from https://github.com/org/app.git, devcontainer.json",
    );
  });

  test("a build uses the repository's Dockerfile and context, resolved from the file's directory, with its args", async () => {
    const l = lab();
    l.repo.set(
      ".devcontainer/devcontainer.json",
      '{"build": {"dockerfile": "Dockerfile", "context": "..", "args": {"VERSION": "2"}}, "containerEnv": {"GREETING": "hi"}}',
    );
    l.repo.set(".devcontainer/Dockerfile", "FROM alpine:3.20\nARG VERSION\n");
    l.repo.set("src/main.txt", "main");

    await createDeclaredTemplate(
      l.host,
      { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
      progressOf(l),
    );

    const build = l.runtime.builds.at(-1);
    expect(build?.args).toEqual({ VERSION: "2" });
    expect(build?.dockerfile).toMatch(/^\.minibox-env-[0-9a-f]{12}\.Dockerfile$/);
    expect(build?.files.get(build?.dockerfile ?? "")).toBe('FROM alpine:3.20\nARG VERSION\nENV GREETING="hi"\n');
    expect(build?.files.has("src/main.txt")).toBe(true);
  });

  test("a devcontainer.json that asks for postCreateCommand is refused, with the reason as a hint", async () => {
    const l = lab();
    l.repo.set(".devcontainer/devcontainer.json", '{"image": "alpine:3.20", "postCreateCommand": "npm install"}');

    const error = await rejectionOf(
      createDeclaredTemplate(
        l.host,
        { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
        progressOf(l),
      ),
    );

    expect(error).toMatchObject({ status: 400, key: "devcontainer_unsupported" });
    expect((error as { hint?: string }).hint).toBeDefined();
    expect(l.runtime.builds).toEqual([]);
  });

  test("a repository with no devcontainer.json is refused, and the path it was asked for is named", async () => {
    const l = lab();
    l.repo.set("README.md", "no devcontainer here");
    const error = await rejectionOf(
      createDeclaredTemplate(
        l.host,
        {
          name: "dev",
          source: { kind: "devcontainer", url: "https://github.com/org/app.git", path: "tools/dev.json" },
          createdBy: "owner",
        },
        progressOf(l),
      ),
    );
    expect(error).toMatchObject({ status: 400, key: "devcontainer_missing" });
  });

  test("a build whose Dockerfile sits outside its context is refused", async () => {
    const l = lab();
    l.repo.set(".devcontainer/devcontainer.json", '{"build": {"dockerfile": "../Dockerfile", "context": "."}}');
    l.repo.set("Dockerfile", "FROM alpine:3.20\n");
    const error = await rejectionOf(
      createDeclaredTemplate(
        l.host,
        { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
        progressOf(l),
      ),
    );
    expect(error).toMatchObject({ status: 400, key: "devcontainer_path_invalid" });
  });
});

describe("a template built from a build context URL", () => {
  let server: ReturnType<typeof createServer>;
  let base = "";
  const withDockerfile = tarBytes([
    { name: "Dockerfile", body: Buffer.from(FROM_ALPINE) },
    { name: "data/", dir: true },
  ]);
  const withoutDockerfile = archive(entry({ name: "README.md", type: "0" }, Buffer.from("no build here")));

  beforeEach(async () => {
    server = createServer((req, res) => {
      const body =
        req.url === "/ctx.tar" ? withDockerfile : req.url === "/no-dockerfile.tar" ? withoutDockerfile : null;
      if (body === null) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/x-tar" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test("downloads the archive, reads the Dockerfile in it, and builds from it", async () => {
    const l = lab();
    await createDeclaredTemplate(
      l.host,
      { name: "ctx", source: { kind: "context", url: `${base}/ctx.tar` }, createdBy: "owner" },
      progressOf(l),
    );
    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(FROM_ALPINE);
    expect(l.progress.join("")).toContain(`Downloading ${base}/ctx.tar`);
  });

  test("an archive without the Dockerfile it names is refused before the build", async () => {
    const l = lab();
    const error = await rejectionOf(
      createDeclaredTemplate(
        l.host,
        { name: "ctx", source: { kind: "context", url: `${base}/no-dockerfile.tar` }, createdBy: "owner" },
        progressOf(l),
      ),
    );
    expect(error).toMatchObject({ status: 400, key: "dockerfile_not_found" });
    expect(l.runtime.builds).toEqual([]);
  });

  test("a URL the server answers with an error is refused as a failed download", async () => {
    const l = lab();
    const error = await rejectionOf(
      createDeclaredTemplate(
        l.host,
        { name: "ctx", source: { kind: "context", url: `${base}/gone.tar` }, createdBy: "owner" },
        progressOf(l),
      ),
    );
    expect(error).toMatchObject({ status: 400, key: "context_fetch_failed" });
  });
});
