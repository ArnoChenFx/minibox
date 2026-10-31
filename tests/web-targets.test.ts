import { describe, expect, test } from "bun:test";

import { TARGET_KINDS as SERVER_KINDS } from "../src/targets/types";
import { KIND_FIELDS, TARGET_KINDS, targetBody } from "../web/js/lib/target-state.js";

const FINGERPRINT = "SHA256:Qk3ZJ0yV0c8uQ4k2b1Fh3tN5mRrS7wXyZ9aBcDeFgHi";
const KEY = "key-line-one\nkey-line-two\n";

const s3Form = {
  kind: "s3",
  name: "  archive  ",
  path: " minibox ",
  endpoint: " https://s3.example.com ",
  region: "us-east-1",
  bucket: "backups",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-value ",
  host: "",
  port: "",
  user: "",
  privateKey: "",
};

const sftpForm = {
  kind: "sftp",
  name: "eu",
  path: "",
  endpoint: "https://ignored.example.com",
  bucket: "ignored",
  host: "sftp.example.com",
  port: "2222",
  user: "minibox",
  privateKey: KEY,
};

const webdavForm = {
  kind: "webdav",
  name: "  dav  ",
  path: " minibox ",
  url: " https://dav.example.com/remote.php/dav/files/u ",
  user: " minibox@example.com ",
  password: "app-password ",
  endpoint: "https://left.from.s3",
  region: "eu-west-1",
  bucket: "left-from-s3",
  accessKeyId: "left",
  secretAccessKey: "left",
  host: "left.from.sftp",
  port: "22",
  privateKey: "left",
};

describe("target kinds", () => {
  test("the console offers the kinds the server keeps, in its order", () => {
    expect([...TARGET_KINDS]).toEqual([...SERVER_KINDS]);
  });

  test("every kind names the settings it keeps", () => {
    expect(Object.keys(KIND_FIELDS).toSorted()).toEqual([...TARGET_KINDS].toSorted());
  });
});

describe("target body", () => {
  test("a WebDAV target sends its url, user and password, and nothing left from another kind", () => {
    expect(targetBody(webdavForm)).toEqual({
      kind: "webdav",
      name: "dav",
      path: "minibox",
      url: "https://dav.example.com/remote.php/dav/files/u",
      user: "minibox@example.com",
      password: "app-password ",
    });
  });

  test("a WebDAV test sends no name and no host key", () => {
    const body = targetBody(webdavForm, { named: false, fingerprint: FINGERPRINT });
    expect(body).toEqual({
      kind: "webdav",
      path: "minibox",
      url: "https://dav.example.com/remote.php/dav/files/u",
      user: "minibox@example.com",
      password: "app-password ",
    });
    expect(body).not.toHaveProperty("hostKeyFingerprint");
  });

  test("an S3 target sends its name and its own settings, trimmed, and none of the SFTP fields", () => {
    expect(targetBody(s3Form)).toEqual({
      kind: "s3",
      name: "archive",
      path: "minibox",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "backups",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret-value",
    });
  });

  test("an SFTP target sends its port as a number, keeps the key's line breaks, and sends the confirmed host key", () => {
    expect(targetBody(sftpForm, { fingerprint: FINGERPRINT })).toEqual({
      kind: "sftp",
      name: "eu",
      host: "sftp.example.com",
      port: 2222,
      user: "minibox",
      privateKey: KEY,
      hostKeyFingerprint: FINGERPRINT,
    });
  });

  test("an SFTP target without a confirmed host key sends none, so the server refuses it", () => {
    expect(targetBody(sftpForm)).not.toHaveProperty("hostKeyFingerprint");
  });

  test("a test sends no name, and a host key only for an SFTP target", () => {
    const tested = targetBody(s3Form, { named: false, fingerprint: FINGERPRINT });
    expect(tested).not.toHaveProperty("name");
    expect(tested).not.toHaveProperty("hostKeyFingerprint");
    expect(targetBody(sftpForm, { named: false, fingerprint: FINGERPRINT })).toMatchObject({
      hostKeyFingerprint: FINGERPRINT,
    });
  });

  test("a blank optional field is left out, and a port the form cannot read is sent as typed for the server to refuse", () => {
    const blank = targetBody({ kind: "sftp", name: "eu", host: "h", port: "  ", user: "u", privateKey: "  \n " });
    expect(blank).toEqual({ kind: "sftp", name: "eu", host: "h", user: "u" });
    expect(targetBody({ ...sftpForm, port: "22x" })).toMatchObject({ port: "22x" });
  });
});
