// Claim page niceties. Progressive enhancement only: every form works without
// this script, and nothing here sends anything the claimant didn't submit.
(function () {
  'use strict';

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // A limit as the page's hint states it ("25 MB").
  function formatLimit(bytes) {
    return bytes >= 1024 * 1024 ? Math.floor(bytes / (1024 * 1024)) + ' MB' : formatSize(bytes);
  }

  // Disable a form's buttons once it is submitting, so a double tap doesn't send twice.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || e.defaultPrevented) return;
    var buttons = form.querySelectorAll('button[type="submit"], button:not([type])');
    // After this tick, so the browser has already built the submission.
    setTimeout(function () {
      buttons.forEach(function (b) {
        b.disabled = true;
        if (b.dataset.busyLabel) {
          b.dataset.label = b.textContent;
          b.textContent = b.dataset.busyLabel;
        }
      });
    }, 0);
  });

  // Coming back with the Back button restores the page from cache: re-enable it.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    document.querySelectorAll('form button[disabled], form input[disabled]').forEach(function (b) {
      b.disabled = false;
      if (b.dataset.label) b.textContent = b.dataset.label;
    });
  });

  // Uploads: show which files are chosen, warn about ones that will be refused
  // before anything is sent, and (where the browser can) send one file per
  // request, so a few large phone photos never make one oversized upload.
  document.querySelectorAll('form.upload-form').forEach(function (form) {
    var input = form.querySelector('input[type="file"]');
    var summary = form.querySelector('[data-file-summary]');
    var csrf = form.querySelector('input[name="_csrf"]');
    var button = form.querySelector('button[type="submit"]');
    if (!input || !summary) return;
    var maxBytes = Number(form.dataset.maxBytes) || 0;
    var maxFiles = Number(form.dataset.maxFiles) || 0;
    var maxTotal = Number(form.dataset.maxTotal) || 0;
    var claimUrl = form.dataset.claimUrl || '';
    var oneByOne = !!(window.fetch && window.FormData && csrf && button && claimUrl);

    function chosen() {
      return Array.prototype.slice.call(input.files || []);
    }

    function tooMany(files) {
      return maxFiles > 0 && files.length > maxFiles;
    }

    function tooBigTogether(files) {
      var total = files.reduce(function (sum, f) {
        return sum + f.size;
      }, 0);
      // Sent one at a time, only each file's own size matters.
      return !oneByOne && maxTotal > 0 && total > maxTotal;
    }

    function showSummary() {
      var files = chosen();
      summary.textContent = '';
      if (!files.length) {
        summary.hidden = true;
        return;
      }
      var lead = files.length === 1 ? '1 file chosen: ' : files.length + ' files chosen: ';
      summary.appendChild(
        document.createTextNode(
          lead +
            files
              .map(function (f) {
                return f.name + ' (' + formatSize(f.size) + ')';
              })
              .join(', '),
        ),
      );
      var warnings = [];
      if (tooMany(files)) {
        warnings.push('You can add up to ' + maxFiles + ' files at a time. Please choose fewer.');
      }
      files.forEach(function (f) {
        if (maxBytes && f.size > maxBytes) {
          warnings.push(f.name + ' is larger than ' + formatLimit(maxBytes) + ' and will not be added.');
        }
      });
      if (tooBigTogether(files)) {
        warnings.push(
          'Together these files are over ' + formatLimit(maxTotal) + ', the most for one upload. Please choose fewer and add the rest afterwards.',
        );
      }
      warnings.forEach(function (w) {
        var span = document.createElement('span');
        span.className = 'file-warning';
        span.textContent = w;
        summary.appendChild(span);
      });
      summary.hidden = false;
    }

    input.addEventListener('change', showSummary);

    // The claim page with the new files, as the form's own response would show
    // it. A URL that differs from this one only in its #fragment wouldn't load
    // the page (just scroll), so then it is reloaded.
    function showClaimPage(added) {
      var target = claimUrl + '?uploaded=' + added;
      if (location.pathname + location.search === target) {
        location.hash = 'files';
        location.reload();
      } else location.assign(target + '#files');
    }

    function alertBox(kind, role) {
      var box = document.createElement('div');
      box.className = 'alert alert-' + kind;
      box.setAttribute('role', role);
      return box;
    }

    // The outcome of a one-by-one upload, in place of the page the server would render.
    function showOutcome(added, errors) {
      ['upload-error', 'upload-added'].forEach(function (id) {
        var old = document.getElementById(id);
        if (old) old.parentNode.removeChild(old);
      });
      var field = input.closest('label') || input;
      if (added) {
        var ok = alertBox('success', 'status');
        ok.id = 'upload-added';
        ok.appendChild(document.createTextNode((added === 1 ? '1 file was' : added + ' files were') + ' added to your claim. '));
        var link = document.createElement('a');
        link.href = claimUrl + '?uploaded=' + added + '#files';
        link.textContent = 'Show them';
        link.addEventListener('click', function (e) {
          e.preventDefault();
          showClaimPage(added);
        });
        ok.appendChild(link);
        form.insertBefore(ok, field);
      }
      var box = alertBox('error', 'alert');
      box.id = 'upload-error';
      var p = document.createElement('p');
      p.textContent = "Some files weren't added:";
      box.appendChild(p);
      var list = document.createElement('ul');
      errors.forEach(function (e) {
        var li = document.createElement('li');
        if (e.name) {
          var strong = document.createElement('strong');
          strong.textContent = e.name;
          li.appendChild(strong);
          li.appendChild(document.createTextNode(': '));
        }
        li.appendChild(document.createTextNode(e.message));
        list.appendChild(li);
      });
      box.appendChild(list);
      form.insertBefore(box, field);
      input.setAttribute('aria-describedby', 'upload-error upload-hint');
    }

    function uploadOneByOne(files) {
      var url = (form.getAttribute('action') || '').split('#')[0];
      var label = button.textContent;
      var added = 0;
      var errors = [];
      var stop = null;
      var i = 0;
      button.disabled = true;
      input.disabled = true;

      function send(f) {
        var data = new FormData();
        data.append('_csrf', csrf.value); // first: the server checks it before reading any file
        data.append('files', f, f.name);
        return fetch(url, { method: 'POST', body: data, credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(
          function (res) {
            if ((res.headers.get('Content-Type') || '').indexOf('application/json') !== -1) {
              return res.json().then(function (body) {
                added += Number(body.added) || 0;
                (body.errors || []).forEach(function (e) {
                  errors.push({ name: e.name || f.name, message: String(e.message) });
                });
              });
            }
            if (res.status === 429) stop = "You've uploaded a lot in a short time. Please wait a few minutes, then add the rest.";
            else if (res.status === 403) stop = 'This page has expired. Please reload it, then add the rest.';
            else errors.push({ name: f.name, message: "We couldn't upload this file. Please try again." });
            return undefined;
          },
          function () {
            errors.push({ name: f.name, message: "We couldn't upload this file. Please check your connection and try again." });
          },
        );
      }

      function finish() {
        if (stop) {
          var left = files.slice(i - 1).map(function (f) {
            return f.name;
          });
          errors.push({ name: null, message: stop + ' Not added: ' + left.join(', ') + '.' });
        }
        if (!errors.length) {
          showClaimPage(added);
          return;
        }
        showOutcome(added, errors);
        input.value = '';
        input.disabled = false;
        showSummary();
        button.disabled = false;
        button.textContent = label;
      }

      function next() {
        if (stop || i >= files.length) return finish();
        var f = files[i++];
        if (maxBytes && f.size > maxBytes) {
          errors.push({ name: f.name, message: 'This file is larger than ' + formatLimit(maxBytes) + '.' });
          return next();
        }
        button.textContent = files.length === 1 ? 'Uploading…' : 'Uploading ' + i + ' of ' + files.length + '…';
        return send(f)
          .catch(function () {
            errors.push({ name: f.name, message: "We couldn't upload this file. Please try again." });
          })
          .then(next);
      }

      next();
    }

    form.addEventListener('submit', function (e) {
      var files = chosen();
      if (!files.length) return; // the browser asks for a file (required)
      if (tooMany(files) || tooBigTogether(files)) {
        e.preventDefault();
        showSummary();
        input.focus();
        return;
      }
      if (!oneByOne) return; // a normal form submission
      e.preventDefault();
      uploadOneByOne(files);
    });
  });
})();
