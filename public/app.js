// Klientkoden för samtliga sidor. Vad som skiljer sidorna åt kommer från en
// JSON-blob i dokumentet, så en och samma fil betjänar både enkelvarianterna
// och /all. Tidigare låg det här inline i två nästan identiska kopior, med
// handeskapade regexar som redan hunnit glida isär.
(() => {
  const cfg = JSON.parse(document.getElementById("cfg").textContent);
  const form = document.getElementById("f");
  const input = document.getElementById("u");
  const button = document.getElementById("b");
  const status = document.getElementById("s");
  const preview = document.getElementById("p");

  // Servern äger filnamnet och skickar det i Content-Disposition. Klienten läser
  // tillbaka det istället för att bygga ett eget — annars glider de isär.
  function nameFrom(res, fallback) {
    const match = (res.headers.get("content-disposition") || "").match(/filename="([^"]+)"/);
    return match ? match[1] : fallback;
  }

  function downloadLink(href, name, text) {
    const a = document.createElement("a");
    a.className = "download";
    a.href = href;
    a.download = name;
    a.textContent = text;
    return a;
  }

  form.onsubmit = async (event) => {
    event.preventDefault();
    const url = input.value;
    button.disabled = true;
    status.textContent = cfg.busy;
    preview.replaceChildren();

    try {
      const res = await fetch(cfg.shotPath + "?url=" + encodeURIComponent(url));

      // Inloggad sparas bilden bara i den synkade mappen — servern svarar med en
      // bekräftelse i stället för filen, så inget onödigt går över tunneln.
      if ((res.headers.get("content-type") || "").includes("application/json")) {
        const body = await res.json();
        if (!res.ok || !body.saved) throw new Error(body.error || "kunde inte spara");
        status.textContent = "Sparad till iCloud: " + body.files.join(", ");
        button.disabled = false;
        return;
      }

      if (!res.ok) throw new Error(await res.text());

      const href = URL.createObjectURL(await res.blob());
      const name = nameFrom(res, cfg.fallbackName);

      if (cfg.mode === "image") {
        const img = document.createElement("img");
        img.src = href;
        // Byggs som DOM-nod, inte innerHTML — url kommer från inmatningsfältet.
        img.alt = "Screenshot av " + url;
        preview.replaceChildren(
          img,
          document.createElement("br"),
          downloadLink(href, name, "Ladda ner")
        );
      } else {
        preview.replaceChildren(downloadLink(href, name, "Ladda ner ZIP"));
      }
      status.textContent = "";
    } catch (err) {
      status.textContent = "Fel: " + err.message;
    }

    button.disabled = false;
  };

  // Ett tryck från senaste-listan: variantens sida öppnas med ?u=<url> och
  // dumpen startar direkt. Parametern städas ur adressfältet så en omladdning
  // inte kör om den av misstag.
  const prefill = new URLSearchParams(location.search).get("u");
  if (prefill) {
    input.value = prefill;
    history.replaceState(null, "", location.pathname);
    form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit"));
  }

  const logout = document.getElementById("logout");
  if (logout) {
    logout.onclick = async (event) => {
      event.preventDefault();
      await fetch("/auth/logout", { method: "POST" });
      location.reload();
    };
  }
})();
