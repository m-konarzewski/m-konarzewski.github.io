function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard
      .writeText(text)
      .catch(() => copyTextFallback(text));
  }

  return copyTextFallback(text);
}

function copyTextFallback(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    return Promise.reject(new Error("Copy failed"));
  }

  return Promise.resolve();
}

function getCodeText(code) {
  const lines = Array.from(code.children);
  const text = lines.length
    ? lines.map((line) => line.textContent.replace(/\r?\n$/, "")).join("\n")
    : code.textContent;

  return text.replace(/\r?\n$/, "");
}

function addCodeCopyButtons() {
  document.querySelectorAll(".content .highlight").forEach((highlight) => {
    const table = highlight.querySelector("table");
    const pre = table
      ? table.querySelector("td:last-child pre")
      : highlight.querySelector("pre");
    const code = pre && pre.querySelector("code");

    if (!pre || !code) {
      return;
    }

    const button = document.createElement("button");
    button.className = "code-copy-button";
    button.type = "button";
    button.innerHTML = '<i class="fa-solid fa-copy" aria-hidden="true"></i>';
    button.setAttribute("aria-label", "Copy code");
    button.dataset.tooltip = "Copy";
    button.addEventListener("click", async () => {
      try {
        await copyText(getCodeText(code));
        button.dataset.tooltip = "Copied!";
      } catch {
        button.dataset.tooltip = "Copy failed";
      }

      window.setTimeout(() => {
        button.dataset.tooltip = "Copy";
      }, 2000);
    });

    highlight.appendChild(button);
  });
}

addCodeCopyButtons();