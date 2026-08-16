# Put your own brand on the workspace

**Who this is for:** workspace admins. No technical knowledge is assumed. If you are
building against the API, read
[the branding and custom domains API reference](../reference/branding-domains-api.md)
instead.

Branding decides what your team sees in the console and what anyone signing in sees on the
sign-in screen — your product name, your logo and your colours in place of the defaults. It
takes a few minutes and nothing about it is permanent.

To move the console onto your own web address as well, see
[Serve the workspace from your own web address](set-up-a-custom-domain.md).

## Before you start

- You are signed in to your workspace as an admin. **Branding** appears in the left
  navigation only for roles that can change it; if you cannot see it, ask an admin.
- Have your logo ready as a **PNG, JPEG or WebP** file under **512 KB**, and your favicon as
  a **PNG or ICO** file under **64 KB**.
- **SVG files are not accepted.** An SVG can carry code that runs in the browser, so the
  workspace refuses them rather than trying to clean them up. Export your logo to PNG.

## What each thing changes

| You set           | It appears                                                             |
| ----------------- | ---------------------------------------------------------------------- |
| Product name      | In the console, on the sign-in screen, and in the browser tab          |
| Support email     | To your agents, when something needs a person                          |
| Primary colour    | On buttons, links, focus rings and the current-page marker             |
| Decorative colour | On backdrops and highlights only — never behind text                   |
| Logo              | In the navigation rail, the mobile top bar, and above the sign-in form |
| Favicon           | As the small icon in a browser tab                                     |

Everyone in your workspace sees the change. Nobody outside it does — another business on the
platform is unaffected by anything you set here.

## Set the name and colours

1. Select **Branding** in the left navigation, under Settings.
2. Under **Identity**, fill in:
   - **Product name** — up to 60 characters. This replaces the platform name everywhere.
   - **Support email** — optional. Leave it empty to hide it.
3. Under **Colours**, set **Primary colour** and **Decorative colour**. Use the colour picker
   or type a six-digit hex value such as `#0b6e4f`.
4. Watch the **Preview** below the fields. It updates as you type and is exactly what the
   console will use once you save.
5. Select **Save changes**.

A **Branding saved** message confirms it. The console picks up the new colours straight away.

**You do not have to get the contrast right.** Beside the primary colour you will see a
reading such as `4.8:1 against its own text` and either **Meets WCAG AA** or **Text on this
colour is adjusted automatically to stay readable**. The console corrects the text on top of
your colour either way, so a dark brand colour is a taste decision rather than a broken
screen. Only the primary colour is checked — the decorative colour never sits behind text.

**Reset to the default colours** puts both colours back to the platform's. It does not save
by itself; select **Save changes** afterwards.

## Upload a logo or favicon

The logo and the favicon are uploaded one at a time, and each is saved on its own — they are
not part of the **Save changes** above.

1. On the same **Branding** page, find **Logo and favicon**.
2. Under **Choose a new logo**, select your file.
3. Select **Save**. **Logo updated** confirms it, and the preview beside the field shows what
   you uploaded.
4. Repeat under **Choose a new favicon** for the tab icon.

A file that is too large or the wrong format is refused **before** it is uploaded, with the
reason under the field. Nothing is sent and nothing is changed — pick another file and try
again.

If you have uploaded nothing, the console shows **Nothing uploaded — the product name is
shown instead**, which is a working state and not an error.

### Remove one

1. Select **Remove logo** (or **Remove favicon**).
2. Read the confirmation and select **Remove**.

The image disappears from every screen in the workspace immediately and the product name
takes its place. You can upload a new one at any time.

## Troubleshooting

**"Use a six-digit hex colour, like #067a52"**
The colour needs all six digits and a leading `#`. Three-digit shorthand and colour names are
not accepted.

**"That logo is over 512 KB." / "That favicon is over 64 KB."**
Export it smaller or resize it. A logo is displayed small; a large file buys nothing.

**"That logo is not a supported image. Use PNG, JPEG or WebP."**
The file is not one of the accepted formats — most often an SVG, or a file renamed to `.png`
without being converted. Export it properly from your design tool.

**"Give this workspace a name"**
The product name cannot be empty. If you want the platform's own name back, type it in.

**"Use 60 characters or fewer"**
Shorten the product name. It has to fit a navigation rail and a browser tab.

**"Enter an email address, or leave it empty"**
The support address is not a valid email. Clear the field to hide the address entirely.

**"Your role can read these details but not change them. Ask a workspace admin."**
Your role can see the settings but not write them. An admin can change that or make the
change for you.

**You saved, and the sign-in screen still shows the old brand.**
The sign-in screen is cached for a short time. Reload it, or open it in a private window. If
it is still wrong after a few minutes, check you are on the right address — a workspace with
more than one hostname shows its branding on all of them, but a stale bookmark to a hostname
that has been removed shows nothing at all.
