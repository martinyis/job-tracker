/**
 * LinkedIn DOM selectors for PUBLIC (non-logged-in) job scraping.
 * These target the public-facing job search and detail pages.
 * NOTE: LinkedIn updates its DOM frequently — these may need maintenance.
 */
export const SELECTORS = {
  /** Public job search results page */
  search: {
    /** Individual job card element */
    jobCard: '.base-card, .base-search-card, .job-search-card',
    /** Job title link within a card */
    jobTitle: '.base-search-card__title, .base-card__full-link',
    /** Company name within a card */
    companyName: '.base-search-card__subtitle, .hidden-nested-link',
    /** Job location within a card */
    location: '.job-search-card__location',
    /** Job link (anchor tag) */
    jobLink: '.base-card__full-link',
    /** Date posted metadata */
    datePosted: 'time, .job-search-card__listdate',
  },

  /** Public job detail page (full page, not a pane) */
  detail: {
    /** Full job description container */
    description: '.show-more-less-html__markup, .description__text, .jobs-description__content',
    /** "Show more" button to expand truncated descriptions */
    showMoreButton: '.show-more-less-html__button--more, .show-more-less-html__button',
    /** Apply button */
    applyButton: '.apply-button, .jobs-apply-button, a[data-tracking-control-name="public_jobs_apply-link-offsite_sign-up-modal"]',
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
