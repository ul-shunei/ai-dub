// Fukurou Library: adds a chapter to a book there, through the book's
// chapter link (made on the book's Details tab in Fukurou Library, good for
// 24 hours). The link is kept in chrome.storage.local, one for the extension.
// The same file is in AI Book Reader and AI Video Dub.
//
// FukurouLibrary.panel(element, source) fills the element with the panel:
// first a field for the link, then the chapter's title and an "Add chapter"
// button. source gives the chapter:
//   title()            the title to start with
//   paragraphs(choice) the text, a string or { text, heading } per paragraph
//   choices()          optional: [{ value, label }] to pick which text to send
//   meta()             optional: details about where the text came from,
//                      { label: value }, shown apart from the text in the
//                      library; a checkbox leaves them out
const FukurouLibrary = (() => {
  const KEY = 'libraryLink';

  async function savedLink() {
    return (await chrome.storage.local.get(KEY))[KEY] || '';
  }

  // A chapter link: https://<api>/inbox/<43-character token>
  function parseLink(text) {
    let url;
    try {
      url = new URL(String(text).trim());
    } catch {
      throw new Error('That is not a link. Copy the chapter link from the book\'s Details tab in Fukurou Library.');
    }
    if (url.protocol !== 'https:' || !/\/inbox\/[\w-]{43}$/.test(url.pathname)) {
      throw new Error('That is not a chapter link. Copy it from the book\'s Details tab in Fukurou Library.');
    }
    return url.origin + url.pathname;
  }

  // Access to the library's address. Must come first in a click handler, so
  // the click still counts; asks only the first time.
  function requestAccess(link) {
    return chrome.permissions.request({ origins: [`${new URL(link).origin}/*`] }).catch(() => false);
  }

  async function call(link, method, body) {
    let res;
    try {
      res = await fetch(link, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Could not reach Fukurou Library. Check your connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `Fukurou Library answered ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const info = (link) => call(link, 'GET');
  const addChapter = (link, chapter) => call(link, 'POST', chapter);

  function timeLeft(until) {
    const min = Math.max(0, Math.round((Date.parse(until) - Date.now()) / 60000));
    return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
  }

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function panel(root, source) {
    let link = '';
    let book = null; // { bookTitle, chapterCount, expiresAt } from the link
    let sent = false; // this chapter went already: no second copy by a second click

    const status = el('p', { className: 'library-status' });
    const setStatus = (text, isError = false) => {
      status.textContent = text;
      status.classList.toggle('error', isError);
    };

    // ---- step 1: the link ----
    const linkInput = el('input', { type: 'url', placeholder: 'https://.../inbox/...', autocomplete: 'off' });
    const saveLink = el('button', { type: 'button', className: 'primary', textContent: 'Use this link' });
    const cancelLink = el('button', { type: 'button', textContent: 'Cancel' });
    const linkForm = el(
      'div',
      { className: 'library-step' },
      el('p', { className: 'library-hint', textContent: 'Paste the chapter link of a book in Fukurou Library. Open the book there, go to Details, and click Make a link. A link works for 24 hours.' }),
      linkInput,
      el('div', { className: 'library-buttons' }, saveLink, cancelLink),
    );

    // ---- step 2: the chapter ----
    const target = el('p', { className: 'library-hint' });
    const changeLink = el('button', { type: 'button', className: 'library-link-button', textContent: 'Change link' });
    const titleInput = el('input', { type: 'text', maxLength: 200 });
    const choice = el('select');
    const choiceRow = el('label', { className: 'library-field' }, el('span', { textContent: 'Text' }), choice);
    const withMeta = el('input', { type: 'checkbox', checked: true });
    const metaText = el('span');
    const metaRow = el('label', { className: 'library-check' }, withMeta, metaText);
    const add = el('button', { type: 'button', className: 'primary', textContent: 'Add chapter' });
    const close = el('button', { type: 'button', textContent: 'Close' });
    const sendForm = el(
      'div',
      { className: 'library-step' },
      el('div', { className: 'library-target' }, target, changeLink),
      el('label', { className: 'library-field' }, el('span', { textContent: 'Chapter title' }), titleInput),
      choiceRow,
      metaRow,
      el('div', { className: 'library-buttons' }, add, close),
    );

    root.replaceChildren(linkForm, sendForm, status);

    function showLinkForm(message = '', isError = false) {
      linkForm.hidden = false;
      sendForm.hidden = true;
      cancelLink.hidden = !book;
      linkInput.value = '';
      setStatus(message, isError);
      linkInput.focus();
    }

    function showSendForm() {
      linkForm.hidden = true;
      sendForm.hidden = false;
      target.textContent = `Adds a chapter at the end of "${book.bookTitle}" (${book.chapterCount} chapters now). The link works for another ${timeLeft(book.expiresAt)}.`;
      setStatus('');
    }

    function fill() {
      sent = false;
      add.disabled = false;
      titleInput.value = source.title() || '';
      fillChoices();
      const labels = Object.keys(details());
      metaRow.hidden = !labels.length;
      metaText.textContent = `Add the details: ${labels.join(', ')}`;
    }

    // The source's details with a value.
    function details() {
      return Object.fromEntries(Object.entries(source.meta?.() || {}).filter(([, v]) => v !== undefined && v !== null && String(v).trim()));
    }

    function fillChoices() {
      const list = source.choices?.() || [];
      const keep = choice.value;
      choice.replaceChildren(...list.map((c) => new Option(c.label, c.value)));
      if (list.some((c) => c.value === keep)) choice.value = keep;
      choiceRow.hidden = list.length < 2;
    }

    // Opens the panel: the saved link, checked, or the field for one.
    async function open() {
      root.hidden = false;
      fill();
      link = await savedLink();
      if (!link) return showLinkForm();
      linkForm.hidden = true;
      sendForm.hidden = true;
      setStatus('Checking the chapter link...');
      try {
        book = await info(link);
        showSendForm();
      } catch (err) {
        book = null;
        showLinkForm(err.message, true);
      }
    }

    saveLink.addEventListener('click', async () => {
      let next;
      try {
        next = parseLink(linkInput.value);
      } catch (err) {
        return setStatus(err.message, true);
      }
      if (!(await requestAccess(next))) return setStatus('Access to Fukurou Library is needed to add chapters to it.', true);
      saveLink.disabled = true;
      setStatus('Checking the chapter link...');
      try {
        book = await info(next);
        link = next;
        await chrome.storage.local.set({ [KEY]: link });
        showSendForm();
      } catch (err) {
        setStatus(err.message, true);
      } finally {
        saveLink.disabled = false;
      }
    });
    linkInput.addEventListener('keydown', (event) => event.key === 'Enter' && saveLink.click());
    cancelLink.addEventListener('click', () => (book ? showSendForm() : (root.hidden = true)));
    changeLink.addEventListener('click', () => showLinkForm());
    close.addEventListener('click', () => (root.hidden = true));
    titleInput.addEventListener('input', () => {
      sent = false;
      add.disabled = false;
    });
    for (const input of [choice, withMeta]) {
      input.addEventListener('change', () => {
        sent = false;
        add.disabled = false;
      });
    }

    add.addEventListener('click', async () => {
      if (sent) return;
      if (!(await requestAccess(link))) return setStatus('Access to Fukurou Library is needed to add chapters to it.', true);
      const paragraphs = source.paragraphs(choice.value);
      if (!paragraphs.length) return setStatus('There is no text to add yet.', true);
      add.disabled = true;
      setStatus('Adding the chapter...');
      try {
        const meta = withMeta.checked ? details() : {};
        const res = await addChapter(link, { title: titleInput.value.trim(), paragraphs, ...(Object.keys(meta).length ? { meta } : {}) });
        sent = true;
        book = { ...book, bookTitle: res.bookTitle, chapterCount: res.chapterCount };
        target.textContent = `Adds a chapter at the end of "${book.bookTitle}" (${book.chapterCount} chapters now). The link works for another ${timeLeft(book.expiresAt)}.`;
        setStatus(`Added "${res.chapter.title}" as chapter ${res.chapterCount} of "${res.bookTitle}".`);
      } catch (err) {
        add.disabled = false;
        if (err.status === 404 || err.status === 410) {
          book = null;
          return showLinkForm(err.message, true);
        }
        setStatus(err.message, true);
      }
    });

    root.hidden = true;
    return {
      open,
      toggle: () => (root.hidden ? open() : (root.hidden = true)),
      close: () => (root.hidden = true),
      // Other text (another chapter, another video): its title, and it can be sent.
      refresh: () => !root.hidden && fill(),
      // The same text, with more of it to choose from (a translation arriving, say).
      updateChoices: () => !root.hidden && fillChoices(),
      get isOpen() {
        return !root.hidden;
      },
    };
  }

  return { panel, parseLink };
})();
