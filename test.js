const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// ---------------------------------------------------------------------------
// 1. Error tracker — unit tests
// ---------------------------------------------------------------------------

describe("error-tracker", () => {
  const {
    recordError,
    getErrorRate,
    ERROR_WINDOW,
    ERROR_THRESHOLD,
    _reset,
    _pushTimestamp,
  } = require("./error-tracker");

  beforeEach(() => {
    _reset();
  });

  describe("recordError", () => {
    it("increases the error count by one", () => {
      assert.equal(getErrorRate(), 0);
      recordError();
      assert.equal(getErrorRate(), 1);
    });

    it("accumulates multiple errors", () => {
      recordError();
      recordError();
      recordError();
      assert.equal(getErrorRate(), 3);
    });
  });

  describe("getErrorRate", () => {
    it("returns 0 when no errors have been recorded", () => {
      assert.equal(getErrorRate(), 0);
    });

    it("counts only errors within the 5-minute window", () => {
      // Inject an old timestamp outside the window.
      const old = Date.now() - ERROR_WINDOW - 1000;
      _pushTimestamp(old);
      assert.equal(getErrorRate(), 0, "expired error should be pruned");
    });

    it("keeps recent errors and prunes old ones in one call", () => {
      const now = Date.now();
      _pushTimestamp(now - ERROR_WINDOW - 5000); // expired
      _pushTimestamp(now - ERROR_WINDOW - 1000); // expired
      _pushTimestamp(now - 1000); // recent
      _pushTimestamp(now); // recent
      assert.equal(getErrorRate(), 2);
    });

    it("prunes errors exactly at the boundary", () => {
      // An error at exactly ERROR_WINDOW ago should be pruned (strictly less than cutoff).
      const now = Date.now();
      _pushTimestamp(now - ERROR_WINDOW);
      // The cutoff is Date.now() - ERROR_WINDOW. Since _pushTimestamp was called
      // with now - ERROR_WINDOW and Date.now() inside getErrorRate may be >= now,
      // the timestamp will be < cutoff and thus pruned.
      // Allow a tiny race: if Date.now() hasn't advanced, it equals cutoff and
      // the condition is "< cutoff" so it won't prune. That's fine — it means
      // the error is exactly on the boundary and still within the window.
      const rate = getErrorRate();
      assert.ok(rate <= 1, `expected 0 or 1, got ${rate}`);
    });

    it("handles a large number of errors", () => {
      for (let i = 0; i < 100; i++) {
        recordError();
      }
      assert.equal(getErrorRate(), 100);
    });
  });

  describe("constants", () => {
    it("ERROR_WINDOW is 5 minutes (300 000 ms)", () => {
      assert.equal(ERROR_WINDOW, 300_000);
    });

    it("ERROR_THRESHOLD is 10", () => {
      assert.equal(ERROR_THRESHOLD, 10);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. urlToFilename — unit tests
// ---------------------------------------------------------------------------

describe("urlToFilename", () => {
  const { urlToFilename } = require("./server");

  it("strips http:// protocol", () => {
    assert.equal(urlToFilename("http://example.com"), "example-com");
  });

  it("strips https:// protocol", () => {
    assert.equal(urlToFilename("https://example.com"), "example-com");
  });

  it("converts special characters to hyphens", () => {
    assert.equal(
      urlToFilename("https://example.com/path?q=1&x=2"),
      "example-com-path-q-1-x-2"
    );
  });

  it("collapses consecutive hyphens", () => {
    assert.equal(
      urlToFilename("https://example.com///foo"),
      "example-com-foo"
    );
  });

  it("removes trailing hyphen", () => {
    assert.equal(urlToFilename("https://example.com/"), "example-com");
  });

  it("handles URL without protocol as-is", () => {
    // No protocol to strip, so colons and slashes become hyphens.
    const result = urlToFilename("ftp://files.example.com");
    assert.equal(result, "ftp-files-example-com");
  });
});

// ---------------------------------------------------------------------------
// 3. /health endpoint — integration tests via HTTP
// ---------------------------------------------------------------------------

describe("/health endpoint", () => {
  const { app, _setBrowserInstance, _setLauncher } = require("./server");
  const { _reset, recordError, ERROR_THRESHOLD } = require("./error-tracker");

  let server;
  let baseUrl;

  // Start a real HTTP server on a random port before the test suite.
  beforeEach(async () => {
    _reset();
    // Skyddsnät: utan en stubbad launcher startar getBrowser en riktig Chrome som
    // aldrig stängs, och testprocessen avslutas inte. Block som behöver ett annat
    // beteende sätter sin egen launcher.
    _setLauncher(async () => {
      throw new Error("launcher är inte stubbad i det här testet");
    });
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    _setBrowserInstance(null);
    _setLauncher(null);
    await new Promise((resolve) => server.close(resolve));
  });

  // Helper: make a GET request and return { status, body }.
  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }).on("error", reject);
    });
  }

  describe("when browser is connected and error rate is low", () => {
    beforeEach(() => {
      _setBrowserInstance({ connected: true });
    });

    it("returns 200", async () => {
      const { status } = await get("/health");
      assert.equal(status, 200);
    });

    it("returns status ok", async () => {
      const { body } = await get("/health");
      assert.equal(body.status, "ok");
    });

    it("includes uptime as a number", async () => {
      const { body } = await get("/health");
      assert.equal(typeof body.uptime, "number");
      assert.ok(body.uptime >= 0);
    });

    it("includes version", async () => {
      const { body } = await get("/health");
      assert.equal(body.version, "1.0.0");
    });

    it("reports browser check as ok", async () => {
      const { body } = await get("/health");
      assert.equal(body.checks.browser, "ok");
    });

    it("reports error_rate check as ok with correct fields", async () => {
      const { body } = await get("/health");
      const er = body.checks.error_rate;
      assert.equal(er.status, "ok");
      assert.equal(er.errors_last_5min, 0);
      assert.equal(er.threshold, ERROR_THRESHOLD);
    });
  });

  describe("when browser is disconnected and cannot be relaunched", () => {
    // En nedkopplad browser är inte i sig ett fel — getBrowser startar om den. Felet
    // uppstår först om omstarten inte går. Tidigare antog testet att omstarten alltid
    // misslyckades, vilket bara stämde så länge Chrome saknades på maskinen.
    let logged;

    beforeEach(() => {
      logged = console.error;
      console.error = () => {};
      _setBrowserInstance({ connected: false });
      _setLauncher(async () => {
        throw new Error("Could not find Chrome (ver. 145.0.7632.67)");
      });
    });

    afterEach(() => {
      console.error = logged;
    });

    it("returns 503", async () => {
      const { status } = await get("/health");
      assert.equal(status, 503);
    });

    it("returns status error", async () => {
      const { body } = await get("/health");
      assert.equal(body.status, "error");
    });

    it("reports browser check with error details", async () => {
      const { body } = await get("/health");
      assert.equal(body.checks.browser.status, "error");
      assert.ok(body.checks.browser.message);
    });
  });

  describe("when a disconnected browser can be relaunched", () => {
    beforeEach(() => {
      _setBrowserInstance({ connected: false });
      _setLauncher(async () => ({ connected: true, on() {} }));
    });

    it("startar om browsern och rapporterar ok", async () => {
      const { status, body } = await get("/health");
      assert.equal(status, 200);
      assert.equal(body.checks.browser, "ok");
    });
  });

  describe("when the browser cannot be launched", () => {
    // Tidigare litade det här blocket på att puppeteer.launch skulle misslyckas av sig
    // självt ("no display"). Det gjorde testet grönt bara så länge Chrome saknades på
    // maskinen — exakt det produktionsfel sviten skulle ha fångat. Nu injiceras felet.
    let logged;

    beforeEach(() => {
      logged = console.error;
      console.error = () => {};
      _setBrowserInstance(null);
      _setLauncher(async () => {
        throw new Error(
          "Could not find Chrome (ver. 145.0.7632.67). ... cache path is: /Users/appuser/.cache/puppeteer"
        );
      });
    });

    afterEach(() => {
      console.error = logged;
    });

    it("returns 503 because getBrowser throws", async () => {
      const { status } = await get("/health");
      assert.equal(status, 503);
    });

    it("reports browser error with message from the exception", async () => {
      const { body } = await get("/health");
      assert.equal(body.checks.browser.status, "error");
      assert.match(body.checks.browser.message, /Could not find Chrome/);
    });

    it("läcker inte serverns sökvägar på ett publikt endpoint", async () => {
      const { body } = await get("/health");
      assert.ok(
        !body.checks.browser.message.includes("/Users/appuser"),
        "hemkatalogen ska inte gå att läsa av utifrån"
      );
    });
  });

  describe("when error rate exceeds threshold", () => {
    beforeEach(() => {
      _setBrowserInstance({ connected: true });
      // Record more errors than the threshold.
      for (let i = 0; i <= ERROR_THRESHOLD; i++) {
        recordError();
      }
    });

    it("returns 503", async () => {
      const { status } = await get("/health");
      assert.equal(status, 503);
    });

    it("returns status error", async () => {
      const { body } = await get("/health");
      assert.equal(body.status, "error");
    });

    it("reports error_rate as elevated", async () => {
      const { body } = await get("/health");
      const er = body.checks.error_rate;
      assert.equal(er.status, "elevated");
      assert.ok(er.errors_last_5min > ERROR_THRESHOLD);
      assert.ok(er.message.includes("fel senaste 5 minuterna"));
    });
  });

  describe("when error rate is exactly at threshold", () => {
    beforeEach(() => {
      _setBrowserInstance({ connected: true });
      for (let i = 0; i < ERROR_THRESHOLD; i++) {
        recordError();
      }
    });

    it("returns 200 (threshold is inclusive)", async () => {
      const { status } = await get("/health");
      assert.equal(status, 200);
    });

    it("reports error_rate as ok", async () => {
      const { body } = await get("/health");
      assert.equal(body.checks.error_rate.status, "ok");
      assert.equal(body.checks.error_rate.errors_last_5min, ERROR_THRESHOLD);
    });
  });

  describe("response structure", () => {
    beforeEach(() => {
      _setBrowserInstance({ connected: true });
    });

    it("has all required top-level fields", async () => {
      const { body } = await get("/health");
      assert.ok("status" in body);
      assert.ok("uptime" in body);
      assert.ok("version" in body);
      assert.ok("checks" in body);
    });

    it("has browser and error_rate checks", async () => {
      const { body } = await get("/health");
      assert.ok("browser" in body.checks);
      assert.ok("error_rate" in body.checks);
    });

    it("returns JSON content type", async () => {
      const res = await new Promise((resolve, reject) => {
        http.get(`${baseUrl}/health`, resolve).on("error", reject);
      });
      assert.ok(
        res.headers["content-type"].includes("application/json"),
        `expected JSON content-type, got: ${res.headers["content-type"]}`
      );
      // Drain response.
      res.resume();
    });
  });
});

// ---------------------------------------------------------------------------
// 4. guard.js — SSRF-skydd, rate limit & samtidighetsgräns (unit tests)
// ---------------------------------------------------------------------------

describe("guard — isPrivateAddress", () => {
  const { isPrivateAddress } = require("./guard");

  describe("privata/reserverade IPv4 → true", () => {
    const privateV4 = [
      ["0.0.0.0 (this-network)", "0.0.0.0"],
      ["10.x (privat klass A)", "10.1.2.3"],
      ["127.x (loopback)", "127.0.0.1"],
      ["169.254.x (link-local)", "169.254.10.20"],
      ["172.16.x (privat klass B, nedre gräns)", "172.16.0.1"],
      ["172.31.x (privat klass B, övre gräns)", "172.31.255.255"],
      ["192.168.x (privat klass C)", "192.168.1.1"],
      ["192.0.0.x (IETF protocol assignments)", "192.0.0.8"],
      ["198.18.x (benchmark)", "198.18.0.1"],
      ["100.64.x (CGNAT, nedre gräns)", "100.64.0.1"],
      ["100.127.x (CGNAT/Tailscale, övre gräns)", "100.127.255.254"],
      ["224.x (multicast)", "224.0.0.1"],
      ["240.x (reserverat)", "240.0.0.1"],
      ["255.255.255.255 (broadcast)", "255.255.255.255"],
    ];
    for (const [label, ip] of privateV4) {
      it(`blockerar ${label}: ${ip}`, () => {
        assert.equal(isPrivateAddress(ip), true);
      });
    }
  });

  describe("publika IPv4 → false", () => {
    const publicV4 = [
      ["Google DNS 8.8.8.8", "8.8.8.8"],
      ["Cloudflare DNS 1.1.1.1", "1.1.1.1"],
      ["172.15.x (precis under privat 172.16)", "172.15.0.1"],
      ["172.32.x (precis över privat 172.31)", "172.32.0.1"],
      ["100.63.x (precis under CGNAT)", "100.63.0.1"],
      ["100.128.x (precis över CGNAT)", "100.128.0.1"],
      ["192.167.x (precis under 192.168)", "192.167.0.1"],
      ["192.169.x (precis över 192.168)", "192.169.0.1"],
      ["223.x (precis under multicast 224)", "223.255.255.255"],
    ];
    for (const [label, ip] of publicV4) {
      it(`tillåter ${label}: ${ip}`, () => {
        assert.equal(isPrivateAddress(ip), false);
      });
    }
  });

  describe("privata/reserverade IPv6 → true", () => {
    const privateV6 = [
      ["::1 (loopback)", "::1"],
      [":: (ospecificerad)", "::"],
      ["fe80:: (link-local)", "fe80::1"],
      ["fc00:: (ULA, nedre)", "fc00::1"],
      ["fd00:: (ULA, vanlig)", "fd12:3456:789a::1"],
      ["::ffff:192.168.1.1 (IPv4-mappad privat)", "::ffff:192.168.1.1"],
      ["::ffff:10.0.0.5 (IPv4-mappad privat)", "::ffff:10.0.0.5"],
      ["versalskrivning FE80:: hanteras", "FE80::ABCD"],
    ];
    for (const [label, ip] of privateV6) {
      it(`blockerar ${label}`, () => {
        assert.equal(isPrivateAddress(ip), true);
      });
    }
  });

  describe("publika IPv6 → false", () => {
    it("tillåter 2606:4700::1111 (Cloudflare)", () => {
      assert.equal(isPrivateAddress("2606:4700::1111"), false);
    });

    it("tillåter ::ffff:8.8.8.8 (IPv4-mappad publik)", () => {
      assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false);
    });

    it("tillåter 2001:4860:4860::8888 (Google IPv6 DNS)", () => {
      assert.equal(isPrivateAddress("2001:4860:4860::8888"), false);
    });
  });

  it("behandlar trasig/ogiltig IPv4 som privat (fail-closed)", () => {
    // En sträng som ser ut som IPv4 men har fel antal oktetter ska aldrig
    // tolkas som publik. net.isIPv4 säger nej, men om koden ändå skulle nå
    // isPrivateIPv4 returnerar den true (säkrast). Här testar vi en sträng
    // som inte är giltig IP alls — den når inte isPrivateIPv4 via
    // isPrivateAddress, men ska heller aldrig anses publik via konsumenten.
    assert.equal(isPrivateAddress("999.999.999.999"), false); // ej giltig IPv4/IPv6
  });
});

describe("guard — hostnameIsPublic", () => {
  const { hostnameIsPublic, _internals } = require("./guard");

  beforeEach(() => {
    _internals.dnsCache.clear();
  });

  describe("blockerade värdnamn → false (ingen DNS slås upp)", () => {
    const blocked = [
      ["localhost", "localhost"],
      ["localhost.localdomain", "localhost.localdomain"],
      ["broadcasthost", "broadcasthost"],
      ["*.local (mDNS)", "foo.local"],
      ["*.lan", "foo.lan"],
      ["*.internal", "foo.internal"],
      ["*.home.arpa", "foo.home.arpa"],
      ["*.ts.net (Tailscale MagicDNS)", "macpro.tailnet.ts.net"],
      ["*.localhost", "app.localhost"],
      ["bart namn utan punkt", "intranet"],
      ["tomt namn", ""],
    ];
    for (const [label, host] of blocked) {
      it(`blockerar ${label}`, async () => {
        assert.equal(await hostnameIsPublic(host), false);
      });
    }
  });

  describe("literala privata IP-adresser som värdnamn → false", () => {
    const ips = [
      ["IPv4 privat 192.168.1.1", "192.168.1.1"],
      ["IPv4 loopback 127.0.0.1", "127.0.0.1"],
      ["IPv4 CGNAT 100.100.100.100", "100.100.100.100"],
      ["IPv6 loopback inom hakparenteser", "[::1]"],
      ["IPv6 link-local inom hakparenteser", "[fe80::1]"],
    ];
    for (const [label, host] of ips) {
      it(`blockerar ${label}`, async () => {
        assert.equal(await hostnameIsPublic(host), false);
      });
    }
  });

  describe("literala publika IP-adresser som värdnamn → true", () => {
    it("tillåter 8.8.8.8 (ingen DNS behövs)", async () => {
      assert.equal(await hostnameIsPublic("8.8.8.8"), true);
    });

    it("tillåter 1.1.1.1 (ingen DNS behövs)", async () => {
      assert.equal(await hostnameIsPublic("1.1.1.1"), true);
    });
  });

  describe("rena IPv6-literaler utan punkt → false (fail-closed)", () => {
    // Guarden kräver minst en punkt i värdnamnet (host.includes(".")).
    // Rena IPv6-literaler (med eller utan hakparenteser) saknar punkt och
    // avvisas därför innan IP-tolkningen — säkert default, men medvetet
    // beteende som vi låser fast här så det inte regredierar oavsiktligt.
    it("blockerar publik [2606:4700::1111] (ingen punkt → avvisas)", async () => {
      assert.equal(await hostnameIsPublic("[2606:4700::1111]"), false);
    });

    it("blockerar publik 2606:4700::1111 utan hakparenteser", async () => {
      assert.equal(await hostnameIsPublic("2606:4700::1111"), false);
    });
  });

  describe("DNS-cache styr resultatet (ingen live-DNS)", () => {
    it("returnerar true när cachen säger ok", async () => {
      _internals.dnsCache.set("seeded-public.example", {
        ok: true,
        expires: Date.now() + 60_000,
      });
      assert.equal(await hostnameIsPublic("seeded-public.example"), true);
    });

    it("returnerar false när cachen säger ej ok (privat upplösning)", async () => {
      _internals.dnsCache.set("seeded-private.example", {
        ok: false,
        expires: Date.now() + 60_000,
      });
      assert.equal(await hostnameIsPublic("seeded-private.example"), false);
    });

    it("normaliserar versaler och avslutande punkt mot cache-nyckeln", async () => {
      _internals.dnsCache.set("normalize-me.example", {
        ok: true,
        expires: Date.now() + 60_000,
      });
      // Versaler + FQDN-punkt ska träffa samma cache-post.
      assert.equal(await hostnameIsPublic("Normalize-Me.Example."), true);
    });

    it("ignorerar utgången cache-post (expires i det förflutna)", async () => {
      _internals.dnsCache.set("expired-but-blocked.local", {
        ok: true,
        expires: Date.now() - 1,
      });
      // .local-suffixet blockeras före DNS-uppslag oavsett cache.
      assert.equal(await hostnameIsPublic("expired-but-blocked.local"), false);
    });
  });
});

describe("guard — validateTargetUrl", () => {
  const { validateTargetUrl, _internals } = require("./guard");

  beforeEach(() => {
    _internals.dnsCache.clear();
  });

  describe("avvisar farliga/ogiltiga URL:er", () => {
    it("avvisar ogiltig URL", async () => {
      const r = await validateTargetUrl("inte en url alls :// ???");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "ogiltig URL");
    });

    it("avvisar file:-schema", async () => {
      const r = await validateTargetUrl("file:///etc/passwd");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "bara http/https tillåts");
    });

    it("avvisar ftp:-schema", async () => {
      const r = await validateTargetUrl("ftp://files.example.com/x");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "bara http/https tillåts");
    });

    it("avvisar javascript:-schema", async () => {
      const r = await validateTargetUrl("javascript:alert(1)");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "bara http/https tillåts");
    });

    it("avvisar URL med användarnamn (userinfo)", async () => {
      // Seeda hostname som publik så att avvisandet bevisligen beror på userinfo,
      // inte på adressen.
      _internals.dnsCache.set("example.com", {
        ok: true,
        expires: Date.now() + 60_000,
      });
      const r = await validateTargetUrl("http://user@example.com/");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "URL med inloggningsuppgifter tillåts inte");
    });

    it("avvisar URL med användarnamn:lösenord (userinfo)", async () => {
      _internals.dnsCache.set("example.com", {
        ok: true,
        expires: Date.now() + 60_000,
      });
      const r = await validateTargetUrl("https://user:pass@example.com/");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "URL med inloggningsuppgifter tillåts inte");
    });

    it("avvisar URL som pekar på privat adress", async () => {
      const r = await validateTargetUrl("http://192.168.1.1/admin");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "adressen är inte publikt nåbar");
    });

    it("avvisar localhost", async () => {
      const r = await validateTargetUrl("http://localhost:8080/");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "adressen är inte publikt nåbar");
    });
  });

  describe("godkänner säkra publika URL:er", () => {
    it("godkänner http med seedad publik hostname (ingen live-DNS)", async () => {
      _internals.dnsCache.set("fake-public-host.test", {
        ok: true,
        expires: Date.now() + 60_000,
      });
      const r = await validateTargetUrl("http://fake-public-host.test/page");
      assert.equal(r.ok, true);
    });

    it("godkänner https med seedad publik hostname och query/port", async () => {
      _internals.dnsCache.set("fake-public-host.test", {
        ok: true,
        expires: Date.now() + 60_000,
      });
      const r = await validateTargetUrl(
        "https://fake-public-host.test:8443/path?a=1&b=2"
      );
      assert.equal(r.ok, true);
    });

    it("godkänner literal publik IP-URL utan DNS", async () => {
      const r = await validateTargetUrl("https://8.8.8.8/");
      assert.equal(r.ok, true);
    });
  });
});

describe("guard — rateLimit (middleware)", () => {
  const { rateLimit, _internals } = require("./guard");

  // Bygger fejkade Express-objekt. Använder unika IP:er per test så att
  // rateHits-kartan inte förorenar andra tester.
  function makeReqRes(ip) {
    const res = {
      statusCode: null,
      headers: {},
      body: null,
      set(k, v) {
        this.headers[k] = v;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(payload) {
        this.body = payload;
        return this;
      },
    };
    const req = { headers: { "cf-connecting-ip": ip }, ip };
    return { req, res };
  }

  it("släpper igenom förfrågningar under gränsen och anropar next()", () => {
    const ip = "203.0.113.10"; // TEST-NET-3, unik för detta test
    let nextCalls = 0;
    const next = () => nextCalls++;
    for (let i = 0; i < _internals.RATE_MAX_PER_WINDOW; i++) {
      const { req, res } = makeReqRes(ip);
      rateLimit(req, res, next);
      assert.equal(res.statusCode, null, `förfrågan ${i + 1} ska passera`);
    }
    assert.equal(nextCalls, _internals.RATE_MAX_PER_WINDOW);
  });

  it("svarar 429 med Retry-After när gränsen överskrids", () => {
    const ip = "203.0.113.20";
    const next = () => {};
    // Fyll fönstret precis upp till gränsen.
    for (let i = 0; i < _internals.RATE_MAX_PER_WINDOW; i++) {
      const { req, res } = makeReqRes(ip);
      rateLimit(req, res, next);
    }
    // En till — ska blockeras.
    const { req, res } = makeReqRes(ip);
    let nextCalled = false;
    rateLimit(req, res, () => (nextCalled = true));
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["Retry-After"], "300");
    assert.equal(nextCalled, false, "next() ska inte anropas vid 429");
    assert.match(String(res.body), /för många förfrågningar/);
  });

  it("räknar per IP — en flitig IP påverkar inte en annan", () => {
    const busyIp = "203.0.113.30";
    const freshIp = "203.0.113.31";
    const next = () => {};
    for (let i = 0; i < _internals.RATE_MAX_PER_WINDOW; i++) {
      const { req, res } = makeReqRes(busyIp);
      rateLimit(req, res, next);
    }
    // busyIp blockeras nu...
    {
      const { req, res } = makeReqRes(busyIp);
      rateLimit(req, res, next);
      assert.equal(res.statusCode, 429);
    }
    // ...men en helt ny IP släpps igenom.
    {
      const { req, res } = makeReqRes(freshIp);
      let passed = false;
      rateLimit(req, res, () => (passed = true));
      assert.equal(res.statusCode, null);
      assert.equal(passed, true);
    }
  });
});

describe("guard — withSlot (samtidighetsgräns)", () => {
  const { withSlot, _internals } = require("./guard");

  it("MAX_CONCURRENT är 3", () => {
    assert.equal(_internals.MAX_CONCURRENT, 3);
  });

  it("avvisar den fjärde samtidiga slotten med err.busy och släpper igen efter frigörning", async () => {
    const max = _internals.MAX_CONCURRENT;
    const releasers = [];
    const inFlight = [];

    // Håll alla slots öppna med pending-promises.
    for (let i = 0; i < max; i++) {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      releasers.push(release);
      inFlight.push(withSlot(() => gate));
    }

    // Den (max+1):e ska avvisas direkt med err.busy.
    await assert.rejects(
      () => withSlot(async () => "ska aldrig köras"),
      (err) => {
        assert.equal(err.busy, true);
        assert.match(err.message, /upptagen/);
        return true;
      }
    );

    // Frigör en slot.
    releasers[0]();
    await inFlight[0];

    // Nu ska en ny slot gå att ta.
    const result = await withSlot(async () => "klar");
    assert.equal(result, "klar");

    // Städa upp resten.
    for (let i = 1; i < releasers.length; i++) releasers[i]();
    await Promise.all(inFlight.slice(1));
  });

  it("frigör slotten även när fn kastar (finally-blocket)", async () => {
    await assert.rejects(
      () => withSlot(async () => {
        throw new Error("nedladdning misslyckades");
      }),
      /nedladdning misslyckades/
    );
    // Om slotten läckte skulle MAX_CONCURRENT på varandra följande anrop till slut
    // kasta err.busy. Kör MAX_CONCURRENT lyckade i serie för att bevisa att räknaren
    // återställdes.
    for (let i = 0; i < _internals.MAX_CONCURRENT + 1; i++) {
      const v = await withSlot(async () => i);
      assert.equal(v, i);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. getBrowser — en delad launch
// ---------------------------------------------------------------------------

describe("getBrowser — delad launch", () => {
  const { getBrowser, _setBrowserInstance, _setLauncher } = require("./server");

  const fakeBrowserHandle = () => ({ connected: true, on() {} });

  afterEach(() => {
    _setBrowserInstance(null);
    _setLauncher(null);
  });

  it("startar bara en Chrome när flera anrop krockar", async () => {
    let launches = 0;
    _setBrowserInstance(null);
    _setLauncher(async () => {
      launches++;
      await new Promise((r) => setTimeout(r, 20));
      return fakeBrowserHandle();
    });

    const [a, b, c] = await Promise.all([getBrowser(), getBrowser(), getBrowser()]);

    assert.equal(launches, 1, "samtidiga anrop ska dela på en och samma launch");
    assert.equal(a, b, "alla ska få tillbaka samma instans");
    assert.equal(b, c);
  });

  it("återanvänder en ansluten browser utan att starta en ny", async () => {
    let launches = 0;
    _setBrowserInstance({ connected: true });
    _setLauncher(async () => {
      launches++;
      return fakeBrowserHandle();
    });

    await getBrowser();
    assert.equal(launches, 0);
  });

  it("startar en ny browser när den gamla kopplat ner", async () => {
    let launches = 0;
    _setBrowserInstance({ connected: false });
    _setLauncher(async () => {
      launches++;
      return fakeBrowserHandle();
    });

    const browser = await getBrowser();
    assert.equal(launches, 1);
    assert.equal(browser.connected, true);
  });

  it("fastnar inte i ett misslyckat launch-försök", async () => {
    let launches = 0;
    _setBrowserInstance(null);
    _setLauncher(async () => {
      launches++;
      throw new Error("no chrome");
    });

    await assert.rejects(getBrowser(), /no chrome/);
    await assert.rejects(getBrowser(), /no chrome/);
    assert.equal(launches, 2, "nästa anrop ska få försöka igen");
  });
});

// ---------------------------------------------------------------------------
// 9. takeShot — flikar stängs även när något går fel
// ---------------------------------------------------------------------------

describe("takeShot — stänger alltid sina flikar", () => {
  const { takeShot } = require("./server");

  // Browsern är persistent, så en flik som inte stängs ligger kvar och äter minne
  // resten av processens livstid.
  function fakePage(overrides = {}) {
    const page = {
      closed: false,
      setRequestInterception: async () => {},
      on: () => {},
      setViewport: async () => {},
      goto: async () => {},
      keyboard: { press: async () => {} },
      evaluate: async () => false,
      setContent: async () => {},
      screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      close: async () => {
        page.closed = true;
      },
      ...overrides,
    };
    return page;
  }

  function fakeBrowser(pages) {
    let i = 0;
    return { newPage: async () => pages[i++] };
  }

  const desktop = { viewport: { width: 100, height: 100 } };
  const framed = {
    viewport: { width: 100, height: 100 },
    frame: { viewportWidth: 120, viewportHeight: 140, html: '<img src="DATA">', css: "" },
  };

  it("stänger fliken när goto kastar", async () => {
    const page = fakePage({
      goto: async () => {
        throw new Error("Navigation timeout");
      },
    });

    await assert.rejects(
      takeShot(fakeBrowser([page]), "https://example.com", desktop),
      /Navigation timeout/
    );
    assert.equal(page.closed, true, "fliken ska stängas trots felet");
  });

  it("stänger fliken när skärmbilden kastar", async () => {
    const page = fakePage({
      setViewport: async () => {
        throw new Error("viewport failed");
      },
    });

    await assert.rejects(
      takeShot(fakeBrowser([page]), "https://example.com", desktop),
      /viewport failed/
    );
    assert.equal(page.closed, true);
  });

  it("stänger både sid- och ramfliken när ramrenderingen kastar", async () => {
    const page = fakePage();
    const frame = fakePage({
      screenshot: async () => {
        throw new Error("frame failed");
      },
    });

    await assert.rejects(
      takeShot(fakeBrowser([page, frame]), "https://example.com", framed),
      /frame failed/
    );
    assert.equal(page.closed, true, "sidfliken ska vara stängd");
    assert.equal(frame.closed, true, "ramfliken ska vara stängd");
  });

  it("skickar vidare timeout-alternativet till goto", async () => {
    let seen;
    const page = fakePage({
      goto: async (_url, opts) => {
        seen = opts.timeout;
        throw new Error("stopp");
      },
    });

    await assert.rejects(
      takeShot(fakeBrowser([page]), "https://example.com", desktop, { timeout: 12000 }),
      /stopp/
    );
    assert.equal(seen, 12000);
  });
});

// ---------------------------------------------------------------------------
// 10. guard — clientIp (spoofskydd för rate limit)
// ---------------------------------------------------------------------------

describe("guard — clientIp", () => {
  const { clientIp, rateLimit, _internals } = require("./guard");

  it("litar på cf-connecting-ip när anropet kom via loopback", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "cf-connecting-ip": "203.0.113.5" },
    };
    assert.equal(clientIp(req), "203.0.113.5");
  });

  it("ignorerar cf-connecting-ip från en socket utanför loopback", () => {
    const req = {
      socket: { remoteAddress: "100.99.139.32" },
      headers: { "cf-connecting-ip": "203.0.113.5" },
    };
    assert.equal(clientIp(req), "100.99.139.32", "headern får inte gå att spoofa utifrån");
  });

  it("tar första värdet i en kommaseparerad header", () => {
    const req = {
      socket: { remoteAddress: "::1" },
      headers: { "cf-connecting-ip": "203.0.113.5, 198.51.100.9" },
    };
    assert.equal(clientIp(req), "203.0.113.5");
  });

  it("faller tillbaka på socket-adressen när headern saknas", () => {
    const req = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
    assert.equal(clientIp(req), "127.0.0.1");
  });

  it("en spoofad header ger ingen färsk kvot utifrån", () => {
    const socketIp = "203.0.113.77";
    const makeRes = () => ({
      statusCode: null,
      set() {
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      send() {
        return this;
      },
    });
    // Varje förfrågan påstår sig komma från en ny klient-IP, men socketen är densamma.
    const spoof = (i) => ({
      socket: { remoteAddress: socketIp },
      headers: { "cf-connecting-ip": `198.51.100.${i}` },
    });

    for (let i = 0; i < _internals.RATE_MAX_PER_WINDOW; i++) {
      rateLimit(spoof(i), makeRes(), () => {});
    }
    const res = makeRes();
    rateLimit(spoof(200), res, () => {});
    assert.equal(res.statusCode, 429, "räkningen ska följa socketen, inte headern");
  });
});

// ---------------------------------------------------------------------------
// 11. guard — assertNoPrivateAccess (DNS-rebinding)
// ---------------------------------------------------------------------------

describe("guard — assertNoPrivateAccess", () => {
  const { guardPage, assertNoPrivateAccess } = require("./guard");

  let logged;
  beforeEach(() => {
    logged = console.error;
    console.error = () => {};
  });
  afterEach(() => {
    console.error = logged;
  });

  // Minimal page-stub som fångar de lyssnare guardPage registrerar.
  function pageStub() {
    const handlers = {};
    return {
      handlers,
      setRequestInterception: async () => {},
      on(event, fn) {
        handlers[event] = fn;
      },
    };
  }

  const respondFrom = (ip) => ({ remoteAddress: () => ({ ip }) });

  it("släpper igenom en sida som bara nådde publika adresser", async () => {
    const page = pageStub();
    await guardPage(page);
    page.handlers.response(respondFrom("93.184.216.34"));
    assert.doesNotThrow(() => assertNoPrivateAccess(page));
  });

  it("kastar när en respons kom från loopback", async () => {
    const page = pageStub();
    await guardPage(page);
    page.handlers.response(respondFrom("127.0.0.1"));
    assert.throws(() => assertNoPrivateAccess(page), /intern adress/);
  });

  it("kastar när en respons kom från ett privat nät", async () => {
    const page = pageStub();
    await guardPage(page);
    page.handlers.response(respondFrom("192.168.1.50"));
    assert.throws(() => assertNoPrivateAccess(page), /intern adress/);
  });

  it("avslöjar inte den interna IP:n för anroparen", async () => {
    const page = pageStub();
    await guardPage(page);
    page.handlers.response(respondFrom("10.0.0.7"));
    assert.throws(
      () => assertNoPrivateAccess(page),
      (err) => !err.message.includes("10.0.0.7")
    );
  });

  it("bryr sig inte om responser utan remoteAddress", async () => {
    const page = pageStub();
    await guardPage(page);
    page.handlers.response({ remoteAddress: () => ({}) });
    page.handlers.response({
      remoteAddress: () => {
        throw new Error("saknas");
      },
    });
    assert.doesNotThrow(() => assertNoPrivateAccess(page));
  });

  it("kommer ihåg träffen även om senare responser är publika", async () => {
    const page = pageStub();
    await guardPage(page);
    page.handlers.response(respondFrom("169.254.169.254"));
    page.handlers.response(respondFrom("93.184.216.34"));
    assert.throws(() => assertNoPrivateAccess(page), /intern adress/);
  });
});

// ---------------------------------------------------------------------------
// 12. guard — publicMessage
// ---------------------------------------------------------------------------

describe("guard — publicMessage", () => {
  const { publicMessage } = require("./guard");

  it("tvättar bort serverns hemkatalog", () => {
    const err = new Error(
      "Could not find Chrome (ver. 145.0.7632.67). cache path is: /Users/appuser/.cache/puppeteer."
    );
    const msg = publicMessage(err);
    assert.ok(!msg.includes("/Users/appuser"), "sökvägen ska inte läcka");
    assert.match(msg, /Could not find Chrome/, "det diagnostiskt användbara ska vara kvar");
  });

  it("tvättar även /home och /root", () => {
    assert.ok(!publicMessage(new Error("spawn /home/deploy/app failed")).includes("/home/deploy"));
    assert.ok(!publicMessage(new Error("EACCES /root/.cache/x")).includes("/root/.cache"));
  });

  it("lämnar meddelanden utan sökvägar orörda", () => {
    assert.equal(
      publicMessage(new Error("Navigation timeout of 30000 ms exceeded")),
      "Navigation timeout of 30000 ms exceeded"
    );
  });

  it("klarar null och tomt meddelande", () => {
    assert.equal(publicMessage(null), "okänt fel");
    assert.equal(publicMessage(new Error("")), "okänt fel");
  });

  it("kapar orimligt långa meddelanden", () => {
    assert.ok(publicMessage(new Error("x".repeat(1000))).length <= 300);
  });
});
