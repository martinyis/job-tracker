/**
 * LinkedIn DOM selectors for BOTH public and authenticated job scraping.
 * These target both the public-facing and logged-in job search pages.
 * NOTE: LinkedIn updates its DOM frequently — these may need maintenance.
 */
export const SELECTORS = {
  /** Job search results page (public + authenticated) */
  search: {
    /** Individual job card element — prefer the outermost container to avoid duplicate matches */
    jobCard: '.scaffold-layout__list-item, .jobs-search-results__list-item, .base-card, .base-search-card, .job-search-card',
    /** Job title link within a card */
    jobTitle: '.base-search-card__title, .base-card__full-link, .job-card-list__title, .artdeco-entity-lockup__title a, a.job-card-container__link',
    /** Company name within a card */
    companyName: '.base-search-card__subtitle, .hidden-nested-link, .job-card-container__primary-description, .artdeco-entity-lockup__subtitle',
    /** Job location within a card */
    location: '.job-search-card__location, .job-card-container__metadata-item, .artdeco-entity-lockup__caption',
    /** Job link (anchor tag) */
    jobLink: '.base-card__full-link, a.job-card-container__link, a.job-card-list__title',
    /** Date posted metadata (only available on public/unauthenticated pages — authenticated cards lack time info) */
    datePosted: 'time, .job-search-card__listdate, .job-card-container__footer-item time',
  },

  /** Public job detail page (full page, not a pane) */
  detail: {
    /** Full job description container */
    description: '.show-more-less-html__markup, .description__text, .jobs-description__content',
    /** "Show more" button to expand truncated descriptions */
    showMoreButton: '.show-more-less-html__button--more, .show-more-less-html__button',
    /** Apply button (public/unauthenticated view) */
    applyButton: '.apply-button, .jobs-apply-button, a[data-tracking-control-name="public_jobs_apply-link-offsite_sign-up-modal"]',
    /** Apply button (authenticated view) */
    applyButtonAuth: '.jobs-apply-button, .jobs-apply-button--top-card, button[data-control-name="jobdetails_topcard_inapply"], a.jobs-apply-button[href], .jobs-s-apply button',
    /** External apply link anchor (authenticated view) */
    externalApplyLink: 'a[data-control-name="jobdetails_topcard_inapply"][href*="http"], a.jobs-apply-button[href*="http"], .jobs-apply-button a[href*="http"]',
    /** Top card info (title, company, location) */
    topCardTitle: '.top-card-layout__title',
    topCardCompany: '.topcard__org-name-link, .top-card-layout__company-url',
    topCardLocation: '.topcard__flavor--bullet, .top-card-layout__bullet',
  },

  /** Login/signup modals that may appear */
  modals: {
    /** Dismiss/close button on signup/login modal */
    dismissButton: '.modal__dismiss, [data-tracking-control-name="public_jobs_apply-link-offsite_sign-up-modal_dismiss"], button[aria-label="Dismiss"]',
    /** The modal overlay itself */
    modalOverlay: '.modal__overlay, .authentication-outlet',
  },
} as const;
