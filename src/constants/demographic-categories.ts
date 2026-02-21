export interface DemographicCategory {
  id: string;
  label: string;
  description: string;
  options: string[];
  defaultAnswer: string;
}

export const DEMOGRAPHIC_CATEGORIES: DemographicCategory[] = [
  {
    id: 'gender',
    label: 'Gender',
    description: 'How you identify. Many applications ask this for diversity tracking.',
    options: ['Male', 'Female', 'Non-binary', 'Prefer not to say', 'Other'],
    defaultAnswer: '',
  },
  {
    id: 'ethnicity',
    label: 'Race / Ethnicity',
    description: 'Used for voluntary EEO (Equal Employment Opportunity) reporting.',
    options: [
      'American Indian or Alaska Native',
      'Asian',
      'Black or African American',
      'Hispanic or Latino',
      'Native Hawaiian or Other Pacific Islander',
      'White',
      'Two or More Races',
      'Prefer not to say',
    ],
    defaultAnswer: '',
  },
  {
    id: 'veteran_status',
    label: 'Veteran Status',
    description: 'Protected veteran classification under VEVRAA.',
    options: [
      'I am not a protected veteran',
      'I identify as one or more of the classifications of a protected veteran',
      'I do not wish to answer',
    ],
    defaultAnswer: '',
  },
  {
    id: 'disability_status',
    label: 'Disability Status',
    description: 'Voluntary self-identification under Section 503 of the Rehabilitation Act.',
    options: [
      'Yes, I have a disability (or previously had a disability)',
      'No, I do not have a disability',
      'I do not wish to answer',
    ],
    defaultAnswer: '',
  },
  {
    id: 'work_authorization',
    label: 'Work Authorization',
    description: 'Whether you are legally authorized to work in your target country.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'sponsorship_required',
    label: 'Sponsorship Requirement',
    description: 'Whether you require visa sponsorship now or in the future.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'age_over_18',
    label: 'Age Verification',
    description: 'Whether you are 18 years of age or older.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'felony_conviction',
    label: 'Criminal History',
    description: 'Whether you have been convicted of a felony. Note: many jurisdictions have ban-the-box laws.',
    options: ['Yes', 'No', 'Prefer not to answer'],
    defaultAnswer: '',
  },
  {
    id: 'drug_test',
    label: 'Drug Testing Consent',
    description: 'Whether you are willing to submit to pre-employment drug testing.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'background_check',
    label: 'Background Check Consent',
    description: 'Whether you consent to a background check as part of the hiring process.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'sexual_orientation',
    label: 'Sexual Orientation',
    description: 'Some companies ask for diversity tracking. Always voluntary.',
    options: [
      'Heterosexual',
      'Gay or Lesbian',
      'Bisexual',
      'Prefer not to say',
      'Other',
    ],
    defaultAnswer: '',
  },
  {
    id: 'non_compete',
    label: 'Non-Compete Agreement',
    description: 'Whether you are currently bound by a non-compete or non-solicitation agreement.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'security_clearance',
    label: 'Security Clearance',
    description: 'Current or prior government security clearance level.',
    options: [
      'None',
      'Confidential',
      'Secret',
      'Top Secret',
      'Top Secret/SCI',
      'Other',
    ],
    defaultAnswer: '',
  },
];
