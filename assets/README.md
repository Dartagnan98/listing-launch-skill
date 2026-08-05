# Brand assets

Phase 0 onboarding copies the realtor's logo files in here and records the paths
in `config/realtor.json`:

```
assets/logo-light.png   light/white logo, used on dark graphic backgrounds
assets/logo-dark.png    dark/black logo, used on light graphic backgrounds
```

PNG with transparency. Any size -- templates scale to a 240px width. If only one
logo exists, point both `branding.logo_light` and `branding.logo_dark` at it.

Logo files are gitignored so a realtor's brand assets never get committed back
to the shared repo.
