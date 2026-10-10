import { describe, it, expect } from "vitest";
import {
  parseOsReleaseText,
  detectNestedGuest,
  isRestrictedGuest,
  parseLxcVersion,
  classifyCgroup,
  getHostCapabilities,
  getHostInfo,
} from "../src/services/virtualization/host.js";

const UBUNTU_OS_RELEASE = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
`;

const DOCKER_CGROUP_V1 = `12:memory:/docker/9f3a1b2c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d
11:cpu,cpuacct:/docker/9f3a1b2c4d5e
1:name=systemd:/docker/9f3a1b2c4d5e
`;

const LXC_CGROUP = `2:cpu,cpuacct:/lxc/panel
1:name=systemd:/lxc/panel
`;

const BARE_CGROUP_V2 = `0::/init.scope
`;

describe("host capability detection", () => {
  it("parses os-release fields", () => {
    expect(parseOsReleaseText(UBUNTU_OS_RELEASE)).toEqual({
      id: "ubuntu",
      name: "Ubuntu",
      version: "24.04.1 LTS (Noble Numbat)",
    });
  });

  it("returns nulls for missing or garbage os-release", () => {
    expect(parseOsReleaseText("")).toEqual({ id: null, name: null, version: null });
    expect(parseOsReleaseText("FOO=bar\n").id).toBeNull();
  });

  it("detects a docker guest from cgroup content", () => {
    expect(
      detectNestedGuest({ dockerenv: false, virt: null, cgroup: DOCKER_CGROUP_V1 })
    ).toBe("docker");
  });

  it("detects docker via /.dockerenv even without cgroup hints", () => {
    expect(
      detectNestedGuest({ dockerenv: true, virt: null, cgroup: BARE_CGROUP_V2 })
    ).toBe("docker");
  });

  it("detects an lxc guest from cgroup content", () => {
    expect(detectNestedGuest({ dockerenv: false, virt: null, cgroup: LXC_CGROUP })).toBe("lxc");
  });

  it("prefers systemd-detect-virt output over cgroup heuristics", () => {
    expect(
      detectNestedGuest({ dockerenv: false, virt: "qemu", cgroup: DOCKER_CGROUP_V1 })
    ).toBe("qemu");
    expect(detectNestedGuest({ dockerenv: false, virt: "none", cgroup: null })).toBeNull();
  });

  it("returns null on bare metal with an uninformative cgroup", () => {
    expect(detectNestedGuest({ dockerenv: false, virt: "none", cgroup: BARE_CGROUP_V2 })).toBeNull();
  });

  it("classifies restricted guests that block nested LXC", () => {
    for (const g of ["docker", "lxc", "lxd", "openvz", "podman", "DOCKER"]) {
      expect(isRestrictedGuest(g)).toBe(true);
    }
    for (const g of [null, "none", "qemu", "kvm", "vmware", "bare"]) {
      expect(isRestrictedGuest(g)).toBe(false);
    }
  });

  it("parses lxc versions defensively", () => {
    expect(parseLxcVersion("5.0.4\n")).toBe("5.0.4");
    expect(parseLxcVersion("lxc version 6.0.0")).toBe("6.0.0");
    expect(parseLxcVersion("no version here")).toBeNull();
    expect(parseLxcVersion("")).toBeNull();
  });

  it("classifies cgroup layouts", () => {
    expect(classifyCgroup(true, false, true)).toBe("v2");
    expect(classifyCgroup(true, true, true)).toBe("hybrid");
    expect(classifyCgroup(false, true, true)).toBe("v1");
    expect(classifyCgroup(false, false, true)).toBe("v1");
    expect(classifyCgroup(false, false, false)).toBe("none");
  });

  it("collects capabilities without throwing on any host", async () => {
    const caps = await getHostCapabilities();
    expect(typeof caps.lxcInstalled).toBe("boolean");
    expect(["v1", "v2", "hybrid", "none"]).toContain(caps.cgroup);
    expect(typeof caps.restrictedGuest).toBe("boolean");
    expect(caps.runtimeUid === null || typeof caps.runtimeUid === "number").toBe(true);
  });

  it("collects host info without throwing on any host", async () => {
    const info = await getHostInfo();
    expect(typeof info.hostname).toBe("string");
    expect(typeof info.memoryTotalMb).toBe("number");
  });
});
