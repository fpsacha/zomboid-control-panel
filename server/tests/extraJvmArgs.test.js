import { describe, expect, it } from "vitest";
import { parseExtraJvmArgs } from "../utils/extraJvmArgs.js";
import { generateStartupScripts } from "../routes/server.js";
import { changesLaunchTarget } from "../routes/servers.js";

// GH #303: extra JVM arguments for the generated start scripts, so a Java
// agent such as ZombieBuddy survives the script being rewritten at every
// start. They go into the .bat and .sh unquoted, so only plain options pass;
// changing them is a launch-target change (files.manage).

const base = { installPath: "/srv/pz", serverName: "Main", zomboidDataPath: "/srv/Zomboid" };

describe("parseExtraJvmArgs", () => {
  it("accepts Java agents and -D/-XX options, Windows paths too", () => {
    expect(parseExtraJvmArgs("  -javaagent:ZombieBuddy.jar=frontend=console   -Dfoo.bar=1 -XX:+UseNUMA ")).toEqual({
      ok: true,
      args: ["-javaagent:ZombieBuddy.jar=frontend=console", "-Dfoo.bar=1", "-XX:+UseNUMA"],
    });
    expect(parseExtraJvmArgs("-javaagent:C:\\mods\\ZB.jar").ok).toBe(true);
    expect(parseExtraJvmArgs("").args).toEqual([]);
    expect(parseExtraJvmArgs(undefined).args).toEqual([]);
  });

  it.each([
    "-Dx=1 & calc.exe",
    "-Dx=%PATH%",
    "-Dx=$(id)",
    "-Dx=`id`",
    "-Dx=\"a\"",
    "-Dx=a;rm",
    "-Dx=a|b",
    "-Dx=a>b",
    "-Dx=!a!",
    "-Dx=a^b",
    "javaagent.jar",
    "-Dx=1\n-Dy=2",
  ])("refuses %j", (value) => {
    expect(parseExtraJvmArgs(value).ok).toBe(false);
  });

  it("refuses a non-string or an over-long value", () => {
    expect(parseExtraJvmArgs(42).ok).toBe(false);
    expect(parseExtraJvmArgs(`-D${"a".repeat(1100)}`).ok).toBe(false);
  });
});

describe("generateStartupScripts with extra JVM arguments", () => {
  it("puts them in both scripts after the panel's own options", () => {
    const { bat, sh } = generateStartupScripts({ ...base, extraJvmArgs: "-javaagent:ZombieBuddy.jar" });
    for (const script of [bat, sh]) {
      expect(script).toMatch(/-Xmx8g[^\n]*-javaagent:ZombieBuddy\.jar[^\n]*-cp /);
    }
  });

  it("refuses to write a value that isn't allowed", () => {
    expect(() => generateStartupScripts({ ...base, extraJvmArgs: "-Dx=1 & calc" })).toThrow();
  });
});

describe("changing extra JVM arguments is a launch-target change", () => {
  it("counts only a real change", () => {
    const stored = { installPath: "/srv/pz", extraJvmArgs: "-javaagent:ZB.jar" };
    expect(changesLaunchTarget(stored, { extraJvmArgs: "-javaagent:Other.jar" })).toBe(true);
    expect(changesLaunchTarget(stored, { extraJvmArgs: "-javaagent:ZB.jar" })).toBe(false);
    expect(changesLaunchTarget({ installPath: "/srv/pz" }, { extraJvmArgs: "" })).toBe(false);
  });
});

describe("Linux script on a Windows install (GH #304)", () => {
  it("says the folder holds the Windows build when only java.exe is there", () => {
    const { sh } = generateStartupScripts(base);
    expect(sh).toContain('if [ -f "./jre64/bin/java.exe" ]');
    expect(sh).toContain("Windows build of the server");
  });
});
