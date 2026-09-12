(() => {
  const form = document.getElementById("f");
  const email = document.getElementById("u");
  const pin = document.getElementById("pin");
  const button = document.getElementById("b");
  const status = document.getElementById("s");
  const step2 = document.getElementById("step2");

  const post = (path, body) =>
    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });

  form.onsubmit = async (event) => {
    event.preventDefault();
    button.disabled = true;
    const askingForPin = !step2.hidden;
    try {
      if (!askingForPin) {
        const res = await post("/auth/login", { email: email.value });
        if (!res.ok) throw new Error((await res.json()).error || "gick inte");
        status.textContent = "Kod skickad. Kolla mejlen.";
        step2.hidden = false;
        email.readOnly = true;
        button.textContent = "Logga in";
        pin.focus();
      } else {
        const res = await post("/auth/verify", { pin: pin.value });
        if (!res.ok) throw new Error((await res.json()).error || "fel kod");
        status.textContent = "Inloggad.";
        location.href = "/";
      }
    } catch (err) {
      status.textContent = err.message;
    }
    button.disabled = false;
  };
})();
