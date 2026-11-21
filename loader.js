'use strict';

window.JOURNAL_LOADER = `<span class="journal-loader" aria-hidden="true"><span class="loader">
  ${[1, 2, 3, 4].map(index => `<span class="box box-${index}">
    <span class="side-left"></span><span class="side-right"></span><span class="side-top"></span>
  </span>`).join('')}
</span></span>`;
