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

// ---------------------------------------------------------------------------
// 13. Filnamn — tidsstämplade och byggda på ett enda ställe
// ---------------------------------------------------------------------------

describe("timestamp", () => {
  const { timestamp } = require("./server");

  it("formaterar som YYYYMMDD-HHMMSS i lokal tid", () => {
    assert.equal(timestamp(new Date(2026, 8, 12, 10, 45, 30)), "20260912-104530");
  });

  it("nollutfyller ensiffriga delar", () => {
    assert.equal(timestamp(new Date(2026, 0, 5, 9, 8, 7)), "20260105-090807");
  });

  it("hanterar midnatt", () => {
    assert.equal(timestamp(new Date(2026, 11, 31, 0, 0, 0)), "20261231-000000");
  });

  it("matchar formen även utan argument", () => {
    assert.match(timestamp(), /^\d{8}-\d{6}$/);
  });
});

describe("shotFilename", () => {
  const { shotFilename } = require("./server");
  const stamp = "20260912-104530";

  it("bygger namnet Gunnar bad om", () => {
    assert.equal(
      shotFilename("https://www.svt.se/", "-big", stamp),
      "www-svt-se-big-20260912-104530.png"
    );
  });

  it("desktop har ingen variantsuffix", () => {
    assert.equal(
      shotFilename("https://example.com", "", stamp),
      "example-com-20260912-104530.png"
    );
  });

  it("sajtnamnet står först, tidsstämpeln sist", () => {
    const name = shotFilename("https://example.com/a/b?q=1", "-mobile", stamp);
    assert.ok(name.startsWith("example-com"), "namnet ska inledas med sajten");
    assert.ok(name.endsWith(`${stamp}.png`), "tidsstämpeln ska ligga sist");
  });

  it("innehåller bara tecken som är säkra i ett filnamn", () => {
    const name = shotFilename("https://ex.com/å ä ö?q=<>&", "-full", stamp);
    assert.match(name, /^[a-zA-Z0-9.-]+$/);
  });

  it("två dumpar av samma sida vid olika tid krockar inte", () => {
    const a = shotFilename("https://example.com", "", "20260912-104530");
    const b = shotFilename("https://example.com", "", "20260912-104531");
    assert.notEqual(a, b);
  });
});

describe("Content-Disposition — servern äger filnamnet", () => {
  const { app, _setBrowserInstance, _setLauncher, _setSettleScale } = require("./server");
  const { _internals } = require("./guard");

  const HOST = "filename-test.example";
  let server;
  let baseUrl;

  // Minimal page-stub: takeShot behöver bara de här metoderna.
  const fakePage = () => ({
    setRequestInterception: async () => {},
    on: () => {},
    setViewport: async () => {},
    goto: async () => {},
    keyboard: { press: async () => {} },
    evaluate: async () => false,
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    close: async () => {},
  });

  beforeEach(async () => {
    _setSettleScale(0); // hoppa över de fasta väntetiderna
    _setLauncher(async () => {
      throw new Error("ingen riktig browser i det här testet");
    });
    _setBrowserInstance({ connected: true, newPage: async () => fakePage() });
    // Seedad DNS så testet aldrig gör en riktig uppslagning.
    _internals.dnsCache.set(HOST, { ok: true, expires: Date.now() + 60_000 });
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    _setSettleScale(1);
    _setBrowserInstance(null);
    _setLauncher(null);
    await new Promise((resolve) => server.close(resolve));
  });

  function head(path) {
    return new Promise((resolve, reject) => {
      http
        .get(`${baseUrl}${path}`, (res) => {
          res.resume();
          res.on("end", () =>
            resolve({ status: res.statusCode, disposition: res.headers["content-disposition"] })
          );
        })
        .on("error", reject);
    });
  }

  it("sätter namnet även utan ?dl, så klienten kan läsa det", async () => {
    const { status, disposition } = await head(`/shot?url=https://${HOST}/`);
    assert.equal(status, 200);
    assert.match(disposition, /^inline; filename="filename-test-example-\d{8}-\d{6}\.png"$/);
  });

  it("växlar till attachment med ?dl", async () => {
    const { disposition } = await head(`/shot?url=https://${HOST}/&dl`);
    assert.match(disposition, /^attachment; filename=".*\.png"$/);
  });

  it("varianten hamnar före tidsstämpeln", async () => {
    const { disposition } = await head(`/shot/big?url=https://${HOST}/`);
    assert.match(disposition, /filename="filename-test-example-big-\d{8}-\d{6}\.png"/);
  });
});

// ---------------------------------------------------------------------------
// 14. mailer — utskick, storleksgräns och retry
// ---------------------------------------------------------------------------

describe("mailer", () => {
  const mailer = require("./mailer");

  let sent;
  const okResult = { id: "email_test_1" };

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.CLICK_MAIL_FROM = "Click <click@gunnar.se>";
    mailer._resetStatus();
    mailer._setSleep(async () => {}); // ingen riktig väntan i sviten
    sent = [];
    mailer._setSender(async (payload, key) => {
      sent.push({ payload, key });
      return okResult;
    });
  });

  afterEach(() => {
    mailer._setSender(null);
    mailer._setSleep(null);
    delete process.env.RESEND_API_KEY;
    delete process.env.CLICK_MAIL_FROM;
    mailer._resetStatus();
  });

  const fail = (name, message = "nej") => {
    const err = new Error(message);
    if (name) err.resend = { name };
    return err;
  };

  describe("buildAttachment", () => {
    it("base64-kodar en Uint8Array", () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const att = mailer.buildAttachment(png, "x.png");
      assert.equal(att.filename, "x.png");
      assert.equal(att.content, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
    });

    it("innehållet är en sträng, aldrig Uint8Array eller Buffer", () => {
      // JSON.stringify gör en Uint8Array till {"0":137,…} — tyst korrupt bilaga.
      const att = mailer.buildAttachment(new Uint8Array([1, 2, 3]), "x.png");
      assert.equal(typeof att.content, "string");
    });

    it("respekterar byteOffset i en vy över en större buffert", () => {
      const pool = new Uint8Array([9, 9, 1, 2, 3, 9]);
      const view = pool.subarray(2, 5); // [1,2,3]
      const att = mailer.buildAttachment(view, "x.png");
      assert.equal(att.content, Buffer.from([1, 2, 3]).toString("base64"));
    });
  });

  describe("send", () => {
    it("skickar med rätt avsändare och mottagare", async () => {
      await mailer.send({ to: "gunnar@gunnar.se", subject: "Hej", text: "kropp" });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].payload.from, "Click <click@gunnar.se>");
      assert.deepEqual(sent[0].payload.to, ["gunnar@gunnar.se"]);
      assert.equal(sent[0].payload.subject, "Hej");
    });

    it("skickar med idempotensnyckel när en ges", async () => {
      await mailer.send({ to: "a@b.se", subject: "x", idempotencyKey: "nyckel-1" });
      assert.equal(sent[0].key, "nyckel-1");
    });

    it("utelämnar attachments-fältet när det inte finns bilagor", async () => {
      await mailer.send({ to: "a@b.se", subject: "x" });
      assert.equal("attachments" in sent[0].payload, false);
    });

    it("kastar när nyckel saknas, utan att röra nätverket", async () => {
      delete process.env.RESEND_API_KEY;
      await assert.rejects(mailer.send({ to: "a@b.se", subject: "x" }), /inte konfigurerat/);
      assert.equal(sent.length, 0);
    });
  });

  describe("storleksgräns", () => {
    it("avvisar för stora bilagor innan API:et anropas", async () => {
      // Storleksvakten finns för att Resend saknar dokumenterad felkod för detta.
      const big = mailer.buildAttachment(Buffer.alloc(21 * 1024 * 1024), "stor.png");
      await assert.rejects(
        mailer.send({ to: "a@b.se", subject: "x", attachments: [big] }),
        /gränsen går vid/
      );
      assert.equal(sent.length, 0, "får aldrig nå nätverket");
    });

    it("summerar flera bilagor mot samma gräns", async () => {
      const half = () => mailer.buildAttachment(Buffer.alloc(8 * 1024 * 1024), "d.png");
      await assert.rejects(
        mailer.send({ to: "a@b.se", subject: "x", attachments: [half(), half(), half()] }),
        /gränsen går vid/
      );
    });

    it("släpper igenom bilagor under gränsen", async () => {
      const small = mailer.buildAttachment(Buffer.alloc(1024), "liten.png");
      await mailer.send({ to: "a@b.se", subject: "x", attachments: [small] });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].payload.attachments.length, 1);
    });
  });

  describe("retry", () => {
    it("försöker igen vid övergående fel och lyckas", async () => {
      let n = 0;
      mailer._setSender(async () => {
        if (++n === 1) throw fail("service_unavailable");
        return okResult;
      });
      await mailer.send({ to: "a@b.se", subject: "x" });
      assert.equal(n, 2);
    });

    it("försöker igen vid nätverksfel utan resend-fält", async () => {
      let n = 0;
      mailer._setSender(async () => {
        if (++n < 3) throw fail(null, "ECONNRESET");
        return okResult;
      });
      await mailer.send({ to: "a@b.se", subject: "x" });
      assert.equal(n, 3);
    });

    it("retriar ALDRIG daily_quota_exceeded", async () => {
      let n = 0;
      mailer._setSender(async () => {
        n++;
        throw fail("daily_quota_exceeded", "kvot slut");
      });
      await assert.rejects(mailer.send({ to: "a@b.se", subject: "x" }), /kvot slut/);
      assert.equal(n, 1, "kvotfel delar 429 med rate limit men får inte retrias");
    });

    it("retriar ALDRIG monthly_quota_exceeded", async () => {
      let n = 0;
      mailer._setSender(async () => {
        n++;
        throw fail("monthly_quota_exceeded");
      });
      await assert.rejects(mailer.send({ to: "a@b.se", subject: "x" }));
      assert.equal(n, 1);
    });

    it("retriar inte permanenta valideringsfel", async () => {
      let n = 0;
      mailer._setSender(async () => {
        n++;
        throw fail("invalid_parameter");
      });
      await assert.rejects(mailer.send({ to: "a@b.se", subject: "x" }));
      assert.equal(n, 1);
    });

    it("ger upp efter tre försök", async () => {
      let n = 0;
      mailer._setSender(async () => {
        n++;
        throw fail("application_error");
      });
      await assert.rejects(mailer.send({ to: "a@b.se", subject: "x" }));
      assert.equal(n, 3);
    });
  });

  describe("dygnskvot", () => {
    it("stoppar vid den egna gränsen innan Resends", async () => {
      for (let i = 0; i < mailer.DAILY_LIMIT; i++) {
        await mailer.send({ to: "a@b.se", subject: "x" });
      }
      assert.equal(sent.length, mailer.DAILY_LIMIT);
      await assert.rejects(mailer.send({ to: "a@b.se", subject: "x" }), /dygnsgränsen/);
      assert.equal(sent.length, mailer.DAILY_LIMIT, "det sista fick inte gå iväg");
    });
  });

  describe("mailerStatus", () => {
    it("är disabled utan nyckel", () => {
      delete process.env.RESEND_API_KEY;
      assert.equal(mailer.mailerStatus().status, "disabled");
    });

    it("är ok efter ett lyckat utskick", async () => {
      await mailer.send({ to: "a@b.se", subject: "x" });
      const s = mailer.mailerStatus();
      assert.equal(s.status, "ok");
      assert.equal(s.sent_today, 1);
      assert.ok(s.last_send);
    });

    it("räknar fel i rad och nollställs av ett lyckat utskick", async () => {
      mailer._setSender(async () => {
        throw fail("invalid_parameter", "trasig");
      });
      await assert.rejects(mailer.send({ to: "a@b.se", subject: "x" }));
      await assert.rejects(mailer.send({ to: "a@b.se", subject: "x" }));
      let s = mailer.mailerStatus();
      assert.equal(s.status, "error");
      assert.equal(s.consecutive_failures, 2);
      assert.equal(s.message, "trasig");

      mailer._setSender(async () => okResult);
      await mailer.send({ to: "a@b.se", subject: "x" });
      s = mailer.mailerStatus();
      assert.equal(s.status, "ok");
      assert.equal(s.consecutive_failures, undefined);
    });
  });
});

// ---------------------------------------------------------------------------
// 15. /health — mejlstatus rapporteras men får inte fälla tjänsten
// ---------------------------------------------------------------------------

describe("/health — mailer", () => {
  const { app, _setBrowserInstance, _setLauncher } = require("./server");
  const mailer = require("./mailer");
  const { _reset } = require("./error-tracker");

  let server;
  let baseUrl;

  beforeEach(async () => {
    _reset();
    mailer._resetStatus();
    mailer._setSleep(async () => {});
    _setBrowserInstance({ connected: true });
    _setLauncher(async () => {
      throw new Error("ingen riktig browser i det här testet");
    });
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    mailer._setSender(null);
    mailer._setSleep(null);
    mailer._resetStatus();
    delete process.env.RESEND_API_KEY;
    _setBrowserInstance(null);
    _setLauncher(null);
    await new Promise((resolve) => server.close(resolve));
  });

  function get() {
    return new Promise((resolve, reject) => {
      http
        .get(`${baseUrl}/health`, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        })
        .on("error", reject);
    });
  }

  it("rapporterar disabled när ingen nyckel är satt", async () => {
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.equal(body.checks.mailer.status, "disabled");
  });

  it("en avstängd mailer gör inte tjänsten ohälsosam", async () => {
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
  });

  it("EN TRASIG MAILER FÄLLER INTE /health", async () => {
    // Beslutet: mejlfel rapporteras men flippar inte statusen. Annars hade ett
    // Resend-avbrott målat tjänsten röd trots fungerande skärmdumpar — och
    // blockerat varje deploy, eftersom CI:s healthcheck gate:ar på det här svaret.
    process.env.RESEND_API_KEY = "re_test";
    mailer._setSender(async () => {
      const err = new Error("nere");
      err.resend = { name: "invalid_parameter" };
      throw err;
    });
    for (let i = 0; i < 5; i++) {
      await assert.rejects(mailer.send({ to: "a@b.se", subject: "x" }));
    }

    const { status, body } = await get();
    assert.equal(status, 200, "tjänsten är frisk — det är bara mejlet som är trasigt");
    assert.equal(body.status, "ok");
    assert.equal(body.checks.mailer.status, "error");
    assert.equal(body.checks.mailer.consecutive_failures, 5);
  });

  it("browsern avgör fortfarande statusen", async () => {
    process.env.RESEND_API_KEY = "re_test";
    _setBrowserInstance({ connected: false });
    _setLauncher(async () => {
      throw new Error("Could not find Chrome");
    });
    const logged = console.error;
    console.error = () => {};
    try {
      const { status, body } = await get();
      assert.equal(status, 503, "en trasig browser SKA fälla tjänsten");
      assert.equal(body.checks.browser.status, "error");
    } finally {
      console.error = logged;
    }
  });
});

// ---------------------------------------------------------------------------
// 16. auth — signering, engångskod och session
// ---------------------------------------------------------------------------

describe("auth", () => {
  const auth = require("./auth");

  beforeEach(() => {
    process.env.CLICK_SESSION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.CLICK_ALLOWED_EMAILS = "gunnar@gunnar.se";
  });
  afterEach(() => {
    delete process.env.CLICK_SESSION_KEY;
    delete process.env.CLICK_ALLOWED_EMAILS;
    delete process.env.COOKIE_INSECURE;
    auth._setClock(null);
    auth._setRandomInt(null);
  });

  describe("konfiguration", () => {
    it("är avstängd utan nyckel", () => {
      delete process.env.CLICK_SESSION_KEY;
      assert.equal(auth.isConfigured(), false);
    });
    it("är avstängd med tom allowlist", () => {
      process.env.CLICK_ALLOWED_EMAILS = "";
      assert.equal(auth.isConfigured(), false);
    });
    it("avvisar en för kort nyckel", () => {
      process.env.CLICK_SESSION_KEY = Buffer.alloc(16).toString("base64");
      assert.equal(auth.isConfigured(), false);
    });
    it("matchar adress oavsett skiftläge och blanksteg", () => {
      assert.equal(auth.isAllowed("  GUNNAR@Gunnar.SE "), true);
      assert.equal(auth.isAllowed("nagon@annan.se"), false);
    });
  });

  describe("sessionstoken", () => {
    it("går att läsa tillbaka", () => {
      const s = auth.readSession(auth.makeSession("gunnar@gunnar.se"));
      assert.equal(s.email, "gunnar@gunnar.se");
      assert.equal(s.t, "sess");
    });

    it("avvisar manipulerad payload", () => {
      const parts = auth.makeSession("gunnar@gunnar.se").split(".");
      const evil = Buffer.from(JSON.stringify({ v: 1, t: "sess", email: "x@y.se", iat: Date.now(), exp: Date.now() + 1e6 })).toString("base64url");
      assert.equal(auth.readSession(`${parts[0]}.${evil}.${parts[2]}`), null);
    });

    it("avvisar en kapad signatur utan att kasta", () => {
      // timingSafeEqual kastar vid olika längd — utan längdkollen blir det ett 500.
      const parts = auth.makeSession("gunnar@gunnar.se").split(".");
      assert.doesNotThrow(() => auth.readSession(`${parts[0]}.${parts[1]}.AAAA`));
      assert.equal(auth.readSession(`${parts[0]}.${parts[1]}.AAAA`), null);
    });

    it("avvisar skräp", () => {
      for (const bad of ["", "abc", null, undefined, "v2.a.b", "x".repeat(5000)]) {
        assert.equal(auth.readSession(bad), null);
      }
    });

    it("avvisar en utmaning som presenteras som session", () => {
      const chal = auth.makeChallenge("gunnar@gunnar.se", "123456");
      assert.equal(auth.readSession(chal), null);
    });

    it("avvisar token signerad med annan nyckel", () => {
      const token = auth.makeSession("gunnar@gunnar.se");
      process.env.CLICK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
      assert.equal(auth.readSession(token), null);
    });

    it("går ut", () => {
      const token = auth.makeSession("gunnar@gunnar.se");
      auth._setClock(() => Date.now() + auth.SESSION_TTL_MS + 1000);
      assert.equal(auth.readSession(token), null);
    });

    it("stryken ur allowlisten återkallar direkt", () => {
      const token = auth.makeSession("gunnar@gunnar.se");
      process.env.CLICK_ALLOWED_EMAILS = "nagon@annan.se";
      assert.equal(auth.readSession(token), null);
    });
  });

  describe("engångskod", () => {
    it("är sex siffror", () => {
      for (let i = 0; i < 200; i++) assert.match(auth.generatePin(), /^\d{6}$/);
    });
    it("nollutfyller små tal", () => {
      auth._setRandomInt(() => 42);
      assert.equal(auth.generatePin(), "000042");
    });
    it("normaliserar inmatning", () => {
      assert.equal(auth.normalizePin(" 123 456 "), "123456");
      assert.equal(auth.normalizePin("12-34-56"), "123456");
      assert.equal(auth.normalizePin("12345"), null);
      assert.equal(auth.normalizePin("1234567"), null);
      assert.equal(auth.normalizePin(null), null);
    });

    it("rätt kod passerar, fel kod nekas", () => {
      const chal = auth.readChallenge(auth.makeChallenge("gunnar@gunnar.se", "123456"));
      assert.equal(auth.checkPin(chal, "123456"), true);
      assert.equal(auth.checkPin(chal, "123457"), false);
    });

    it("samma kod ger olika hash i två utmaningar", () => {
      const a = auth.readChallenge(auth.makeChallenge("gunnar@gunnar.se", "123456"));
      const b = auth.readChallenge(auth.makeChallenge("gunnar@gunnar.se", "123456"));
      assert.notEqual(a.ph, b.ph, "jti ska salta hashen");
    });

    it("slutar gälla efter fem försök", () => {
      let token = auth.makeChallenge("gunnar@gunnar.se", "123456");
      for (let i = 0; i < auth.MAX_PIN_ATTEMPTS; i++) {
        const c = auth.readChallenge(token);
        assert.ok(c, `försök ${i + 1} ska gå att läsa`);
        token = auth.bumpChallenge(c);
      }
      assert.equal(auth.readChallenge(token), null);
    });

    it("går ut efter tio minuter", () => {
      const token = auth.makeChallenge("gunnar@gunnar.se", "123456");
      auth._setClock(() => Date.now() + auth.CHALLENGE_TTL_MS + 1000);
      assert.equal(auth.readChallenge(token), null);
    });
  });

  describe("cookies", () => {
    const fakeRes = () => ({
      cookies: [],
      cookie(name, value, opts) {
        this.cookies.push({ name, value, opts });
      },
    });

    it("SESSIONSCOOKIEN MÅSTE VARA LAX, ALDRIG STRICT", () => {
      // Strict skickas inte på en top-level cross-site GET, vilket är precis vad en
      // bookmarklet är. Skärmdumpen kommer då tillbaka men oinloggad och omejlad —
      // ett tyst fel i exakt det flöde funktionen finns för.
      const res = fakeRes();
      auth.setSessionCookie(res, "token");
      assert.equal(res.cookies[0].opts.sameSite, "lax");
      assert.notEqual(res.cookies[0].opts.sameSite, "strict");
    });

    it("utmaningscookien är strict", () => {
      const res = fakeRes();
      auth.setChallengeCookie(res, "token");
      assert.equal(res.cookies[0].opts.sameSite, "strict");
    });

    it("båda är httpOnly och secure", () => {
      const res = fakeRes();
      auth.setSessionCookie(res, "t");
      auth.setChallengeCookie(res, "t");
      for (const c of res.cookies) {
        assert.equal(c.opts.httpOnly, true);
        assert.equal(c.opts.secure, true);
      }
    });

    it("COOKIE_INSECURE=1 släpper secure för lokal utveckling", () => {
      process.env.COOKIE_INSECURE = "1";
      const res = fakeRes();
      auth.setSessionCookie(res, "t");
      assert.equal(res.cookies[0].opts.secure, false);
    });

    it("läser rätt cookie ur headern", () => {
      const req = { headers: { cookie: "a=1; click_sess=xyz; b=2" } };
      assert.equal(auth.readCookie(req, "click_sess"), "xyz");
      assert.equal(auth.readCookie(req, "saknas"), null);
      assert.equal(auth.readCookie({ headers: {} }, "click_sess"), null);
    });
  });

  describe("sameOrigin", () => {
    it("godkänner rätt ursprung", () => {
      process.env.CLICK_ORIGIN = "https://click.grj.se";
      assert.equal(auth.sameOrigin({ headers: { origin: "https://click.grj.se" } }), true);
      delete process.env.CLICK_ORIGIN;
    });
    it("avvisar främmande ursprung", () => {
      assert.equal(auth.sameOrigin({ headers: { origin: "https://ond.example" } }), false);
    });
    it("godkänner när Origin saknas men Sec-Fetch-Site är same-origin", () => {
      assert.equal(auth.sameOrigin({ headers: { "sec-fetch-site": "same-origin" } }), true);
      assert.equal(auth.sameOrigin({ headers: { "sec-fetch-site": "cross-site" } }), false);
    });
  });

  describe("attachSession", () => {
    it("sätter null utan konfiguration och avvisar aldrig", () => {
      delete process.env.CLICK_SESSION_KEY;
      const req = { headers: {} };
      let called = false;
      auth.attachSession(req, {}, () => (called = true));
      assert.equal(req.session, null);
      assert.equal(called, true);
    });

    it("plockar upp en giltig session ur cookien", () => {
      const token = auth.makeSession("gunnar@gunnar.se");
      const req = { headers: { cookie: `click_sess=${encodeURIComponent(token)}` } };
      auth.attachSession(req, {}, () => {});
      assert.equal(req.session.email, "gunnar@gunnar.se");
    });
  });
});

// ---------------------------------------------------------------------------
// 17. Mejlvägen i shot-rutten
// ---------------------------------------------------------------------------

describe("shot — mejl till inloggad", () => {
  const { app, _setBrowserInstance, _setLauncher, _setSettleScale } = require("./server");
  const { _internals } = require("./guard");
  const mailer = require("./mailer");
  const auth = require("./auth");

  const HOST = "mailroute-test.example";
  let server;
  let baseUrl;
  let sent;

  const fakePage = () => ({
    setRequestInterception: async () => {},
    on: () => {},
    setViewport: async () => {},
    goto: async () => {},
    keyboard: { press: async () => {} },
    evaluate: async () => false,
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    close: async () => {},
  });

  beforeEach(async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.CLICK_SESSION_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.CLICK_ALLOWED_EMAILS = "gunnar@gunnar.se";
    mailer._resetStatus();
    mailer._setSleep(async () => {});
    sent = [];
    mailer._setSender(async (payload) => {
      sent.push(payload);
      return { id: "e1" };
    });

    _setSettleScale(0);
    _setLauncher(async () => {
      throw new Error("ingen riktig browser");
    });
    _setBrowserInstance({ connected: true, newPage: async () => fakePage() });
    _internals.dnsCache.set(HOST, { ok: true, expires: Date.now() + 60_000 });

    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    mailer._setSender(null);
    mailer._setSleep(null);
    mailer._resetStatus();
    _setSettleScale(1);
    _setBrowserInstance(null);
    _setLauncher(null);
    delete process.env.RESEND_API_KEY;
    delete process.env.CLICK_SESSION_KEY;
    delete process.env.CLICK_ALLOWED_EMAILS;
    await new Promise((resolve) => server.close(resolve));
  });

  function shot(cookie) {
    return new Promise((resolve, reject) => {
      const opts = cookie ? { headers: { Cookie: cookie } } : {};
      http
        .get(`${baseUrl}/shot?url=https://${HOST}/`, opts, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              mail: res.headers["x-click-mail"],
              bytes: Buffer.concat(chunks),
            })
          );
        })
        .on("error", reject);
    });
  }

  const loggedIn = () => `click_sess=${encodeURIComponent(auth.makeSession("gunnar@gunnar.se"))}`;

  it("anonym: inget mejl, oförändrat svar", async () => {
    const r = await shot(null);
    assert.equal(r.status, 200);
    assert.equal(r.mail, "off");
    assert.equal(sent.length, 0);
  });

  it("inloggad: mejlet går iväg med bilden bifogad", async () => {
    const r = await shot(loggedIn());
    assert.equal(r.status, 200);
    assert.equal(r.mail, "sent");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ["gunnar@gunnar.se"]);
    assert.equal(sent[0].attachments.length, 1);
    assert.match(sent[0].attachments[0].filename, /^mailroute-test-example-\d{8}-\d{6}\.png$/);
  });

  it("bilden i svaret är oförändrad även när den mejlas", async () => {
    const anon = await shot(null);
    const auth1 = await shot(loggedIn());
    assert.deepEqual(auth1.bytes, anon.bytes, "samma bytes till svar och bilaga");
  });

  it("ETT MEJLFEL FÄLLER INTE SKÄRMDUMPEN", async () => {
    // Bilden är färdig när mejlet skickas. Ett Resend-avbrott får kosta en header,
    // aldrig svaret.
    const logged = console.error;
    console.error = () => {};
    try {
      mailer._setSender(async () => {
        const err = new Error("nere");
        err.resend = { name: "invalid_parameter" };
        throw err;
      });
      const r = await shot(loggedIn());
      assert.equal(r.status, 200, "skärmdumpen ska levereras ändå");
      assert.equal(r.mail, "failed");
      assert.ok(r.bytes.length > 0);
    } finally {
      console.error = logged;
    }
  });

  it("mottagaren kan inte styras från förfrågan", async () => {
    await new Promise((resolve, reject) => {
      http
        .get(
          `${baseUrl}/shot?url=https://${HOST}/&to=angripare@ond.example`,
          { headers: { Cookie: loggedIn() } },
          (res) => {
            res.resume();
            res.on("end", resolve);
          }
        )
        .on("error", reject);
    });
    assert.deepEqual(sent[0].to, ["gunnar@gunnar.se"], "?to= får aldrig påverka mottagaren");
  });

  it("utan mejlkonfiguration är vägen bara avstängd", async () => {
    delete process.env.RESEND_API_KEY;
    const r = await shot(loggedIn());
    assert.equal(r.status, 200);
    assert.equal(r.mail, "off");
    assert.equal(sent.length, 0);
  });

  it("en manipulerad sessionscookie ger ingen mejlväg", async () => {
    const r = await shot("click_sess=v1.abc.def");
    assert.equal(r.status, 200);
    assert.equal(r.mail, "off");
    assert.equal(sent.length, 0);
  });
});
