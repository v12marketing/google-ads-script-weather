// Claim page niceties. Progressive enhancement only: every form works without
// this script, and nothing here submits anything on its own.
(function () {
  'use strict';

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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
    document.querySelectorAll('form button[disabled]').forEach(function (b) {
      b.disabled = false;
      if (b.dataset.label) b.textContent = b.dataset.label;
    });
  });

  // Show which files are chosen and warn about ones that will be refused.
  document.querySelectorAll('form.upload-form').forEach(function (form) {
    var input = form.querySelector('input[type="file"]');
    var summary = form.querySelector('[data-file-summary]');
    if (!input || !summary) return;
    var maxBytes = Number(form.dataset.maxBytes) || 0;
    var maxFiles = Number(form.dataset.maxFiles) || 0;

    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
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
      if (maxFiles && files.length > maxFiles) {
        warnings.push('You can add up to ' + maxFiles + ' files at a time. Please choose fewer.');
      }
      files.forEach(function (f) {
        if (maxBytes && f.size > maxBytes) {
          warnings.push(f.name + ' is larger than ' + formatSize(maxBytes) + ' and will not be added.');
        }
      });
      warnings.forEach(function (w) {
        var span = document.createElement('span');
        span.className = 'file-warning';
        span.textContent = w;
        summary.appendChild(span);
      });
      summary.hidden = false;
    });
  });
})();
