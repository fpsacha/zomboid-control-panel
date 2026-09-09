import { describe, expect, it } from "vitest";
import fs from "fs";

const readRepoFile = (relativePath) =>
  fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

describe("Docker deployment guidance", () => {
  it("uses the all-in-one installer as the primary local-server path", () => {
    const readme = readRepoFile("README.md");
    // Bounded by the next heading (## or ###) rather than a specific one --
    // "### Indifferent Broccoli" no longer directly follows this section
    // (README.md's install-guide rewrite turned it into a docs/install/hosted.md
    // chooser-table row instead of an inline heading), so anchoring on it left
    // this regex matching nothing rather than failing loudly on content.
    const dockerSection = readme.match(
      /### Docker and Unraid([\s\S]*?)\n#{2,3} /,
    )?.[1];

    expect(dockerSection).toBeTruthy();
    expect(dockerSection).toContain("docker/all-in-one/bootstrap.sh");
    expect(dockerSection).toMatch(/publishes\s+the required UDP ports/);
    expect(dockerSection.indexOf("docker/all-in-one/bootstrap.sh")).toBeLessThan(
      dockerSection.indexOf("docker-compose.install.yml"),
    );
  });

  it("publishes both PZ UDP ports in the all-in-one Compose stack", () => {
    const compose = readRepoFile("docker/all-in-one/docker-compose.yml");

    expect(compose).toContain('"16261:16261/udp"');
    expect(compose).toContain('"16262:16262/udp"');
  });

  it("pulls immutable release images before falling back to local builds", () => {
    const bootstrap = readRepoFile("docker/all-in-one/bootstrap.sh");

    expect(bootstrap).toContain("zomboid-panel:aio-$VERSION");
    expect(bootstrap).toContain("zomboid-panel:updater-$VERSION");
    expect(bootstrap).toContain('docker pull "$published_image"');
    expect(bootstrap).toContain('docker build -t "$local_image"');
    expect(bootstrap).toContain("up -d --no-build");
    expect(bootstrap).toContain('if [ "$health" = "healthy" ]');
    expect(bootstrap).toContain("All-in-one installation is ready.");
  });

  it("publishes versioned panel and updater images from release tags", () => {
    const workflow = readRepoFile(".github/workflows/docker-aio-build.yml");

    expect(workflow).toContain("- 'v*'");
    expect(workflow).toContain("type=raw,value=updater");
    expect(workflow).toContain("type=semver,pattern={{version}},prefix=aio-");
    expect(workflow).toContain(
      "type=semver,pattern={{version}},prefix=updater-",
    );
    expect(workflow.match(/flavor: latest=false/g) || []).toHaveLength(2);
  });

  it("uploads the Linux archive from the release tree created by build.js", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");

    expect(workflow).toContain("archive_path: release/ZomboidControlPanel-linux.tar.gz");
    expect(workflow).toContain("path: ${{ matrix.archive_path }}");
  });

  it("uploads the Windows archive from the root path created by Compress-Archive", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");

    expect(workflow).toContain("archive_path: ZomboidControlPanel-windows.zip");
  });

  it("verifies all release versions before tag publication", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");
    const verifier = readRepoFile("scripts/verify-release-version.mjs");

    expect(workflow).toContain("node scripts/verify-release-version.mjs");
    expect(verifier).toContain("package-lock.json root package");
    expect(verifier).toContain("PanelBridge must contain exactly one");
    expect(verifier).toContain("release-manifest.json client file inventory differs");
  });

  it("keeps the generic installer explicitly panel-only", () => {
    const compose = readRepoFile("docker-compose.install.yml");

    expect(compose).toContain("Project Zomboid runs on another machine");
    expect(compose).not.toContain("16261:16261/udp");
    expect(compose).not.toContain("16262:16262/udp");
  });

  it("documents the opt-in Docker lifecycle prerequisites", () => {
    const compose = readRepoFile("docker-compose.yml");
    const docs = readRepoFile("docs/install/docker.md");

    expect(compose).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(compose).toContain("PANEL_DOCKER_CONTROL_ENABLED");
    expect(compose).toContain("group_add:");
    expect(docs).toContain("zomboid-panel.managed: \"true\"");
    expect(docs).toContain("docker update --label-add zomboid-panel.managed=true");
    expect(docs).toContain("PANEL_DOCKER_CONTROL_ENABLED=true");
    expect(docs).toContain("/var/run/docker.sock");
    expect(docs).toContain("--group-add=281");
  });

  it("offers the Unraid Docker socket field as optional, blank-by-default, and distinct from the container-control grant", () => {
    const xml = readRepoFile("docker/unraid/zomboid-panel.xml");
    const docs = readRepoFile("docs/install/docker.md");

    const socketConfig = xml.match(
      /<Config Name="Docker socket \(optional\)"[\s\S]*?\/>/,
    )?.[0];
    expect(socketConfig).toBeTruthy();
    expect(socketConfig).toContain('Target="/var/run/docker.sock"');
    // Blank by default: Unraid only includes a Path mapping in the actual
    // `docker run` it issues when the field has a value, so an empty
    // Default here is what makes this genuinely opt-in rather than silently
    // granted the moment someone clicks through the install -- see this
    // Config's own long Description for why that distinction matters.
    expect(socketConfig).toContain('Default=""');
    expect(socketConfig).toContain('Required="false"');
    // Hidden behind Advanced View, not shown on the plain install screen --
    // the operator must go looking for it, not stumble into it.
    expect(socketConfig).toContain('Display="advanced"');
    // Must NOT claim to grant PANEL_DOCKER_CONTROL_ENABLED-style container
    // control -- that is the separate, later "Optional: let the panel
    // control the Unraid PZ container" section, with its own explicit
    // opt-in steps (group_add, the zomboid-panel.managed label). This field
    // alone only unlocks path translation.
    expect(socketConfig).not.toContain("PANEL_DOCKER_CONTROL_ENABLED");

    expect(docs).toContain("Optional: let the panel find your folders automatically");
    expect(docs.indexOf("Optional: let the panel find your folders automatically")).toBeLessThan(
      docs.indexOf("Optional: let the panel control the Unraid PZ container"),
    );
  });
});