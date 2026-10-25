// The "reason" wordmark every page Reason serves puts top left: the same mark as the top left of the
// marketing site (reason.omarinyarko.com, ~/Desktop/reason-site-new/public — index.html .nav-mark,
// styles.css .wordmark/.wm-bubble), copied here rather than linked so a page needs nothing but this
// server. "reas", the blue speech bubble as the o, "n", in Instrument Serif italic.
//
// The font rides inline: Instrument Serif Italic (SIL Open Font License, © 2022 The Instrument Serif
// Project Authors) cut down to the letters of "reasoning" — 1.5 KB — so the mark is the real face on
// the first paint, with no request and nothing from Google. The site has no dark mode; on a dark page
// the letters take the page's light ink and the bubble stays the site's blue.

const FONT = "data:font/woff2;base64,d09GMgABAAAAAAXUAA4AAAAACuAAAAWAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGhYbgXocKgZgAFwRCAqJQIdqATYCJAMgCxIABCAFhF4HIBv/CFGUL04e4GdCmTLgsfPQ4HRYRquX3LLTlC3/4bPZ49jv3r5rFLOEqW6YJRo1UxpEEt43/Hvm652TwjrYOdjL5nRzMQO/AHiiv9jb/y+MMKGaJAssaKaZiyihcgqj9LY6AP///Vz9bypxUbRkFaCFu/lFxNLEE2ISf+JQ2hIQxUJeQkvmcDqhWyiV0As2lnPVWAfa770JCGAEAABDiAYhgF5IATud+8dhft7EIcyUAPQZM9b76SG08CkoMSWjF2gw4uXEfglRI4p+Gk75pW69cKdxUjf53jHys0ur/Dq6AU++P4p0EQwx6rjmFNRUvoShyoepiKQ+MCLG9S4glyuzJ3O5AnsNpD8XcyVGUiYSA2JPQv+vfCaeVOLz+XaZuzv+OAVtTjen+ygADCa1kwLJlboHzLTpee+KDVt2HOIt4EadfnDfXdalXVJHrXBxQhqZJKK9EbACjEAfgO1AKuP5iGyK5OZD6HBcipQQTaTg5RFG/zzsNA59QJKwZR/DZpCxHA4ZHbkrO1PgOM9Gv3sXwu7LZA67rU9quYNO4lAIu/qN3gU3SWDeT8KWY+A4IXct2zoBPHWKH/hki6w21hU+mCMs5QUOB3PzcpWxff1uETAmGTbWjhvj6CZwIzZpt0MYm7WdsU3sRb5r18oDrYsUeZdOOVWnaMI22HLnAQ7dDmE375ZYHpzAoceDlev30i+eBG+VY5tx6BFhEw6WYLtlxUsWYyeezLVCGO/Bgyt+uV1iZOGi5CXY8zEXE0Bgb7WxZupG9ykzPpKaxME3fVpWvGJx4EASYjZYaGCMJYTJjycIFy9BHiq3LA+7r7SzRI4Cq26Zyk/g0OXbtcfLAPbxcwobXdIoU7h692R4FDxlOLXrf93dq4iHfDQ0SNQVUB+fkW5U0YQ7EDc3ZMdDN4IBGSNGylhp1Egt5B7CopZGZBpU4qiL55mowr8mN+M0e1FgsamRXykN03GX+2ZoazgtvjIPMMHDLyI7NdqIpjQWRehMM5WGcKQjLoWc6+xGcg9qlCrj48bVnm4apqigqLDIiTm98mZOrDZPo5UIYmKCWkHJg4ysILXMPzpJu864ftcOTorOSly3Y7PM37cECQpgfdtT7JIsYNTSaAUUwqVFMPNiYHjBPF+TOjc++BHtcmn/y8d/8kTdm1Tm8Lh6BfOvcSNH3CQp8fa2ckVDkmIeUxXD2SGRQJ+UTJ8fpTkiRS64UkLDaDwSg76Rzhc11El2XkgKjWsgUddyk0IhUiUj1pwmYsh8KqfHeKeLQH/ZbDQl+U2wm906FcrMhLIfXAWPkCJpPkKm19CTtJCHjkWN0aVeY8lD/qdK1r8jMvuCygL69egzLawhgkiiXihun/8cRX5YjJq3lcMZpZFf1Ix7kkwp/hO8V1BztDDo9pAk0oy1MGMiH4KJIrZcIX6oZt1/uoJHlEakp4TxTKSpWt4UvaenwBRSLRcPiyT+r6bckGjlUaLvAQAEIJCR6+KSJfSvJTm/BHiD/o4B8B50o31s92bEfGxQYzij/RReEYR+4qUvIF9AOxDmPLZPCWPm9WjEzMMTmNPBHGO/BaD1xM0zF4Q0KMZ+jVnbrMUTAK/ApiU+r1rG6EOr0Opfq5SJv1ZFpOYx1VJ56OjIsSundmzZJvgU5BQU+IzbtsGnxyFOOHXmwMYWwg6M2eDFzQmHbeVHdm1Y86+SFmeEbUdOcT4x2wThGNeQlbVlBwXY1KqMtY3+QDY08DG1M5LG47C7eCwn9xBW7NuZMnkZOZpqGjS00XZoSlm4bkoPq8yTxRwNk37INzxCb/bFAQYigEu+4kx+ZDsicSDmfMSaTkrGVWll69NXxTVt2Zw+d0f2cXNyMuoyCqoWUpRSgPwynpYqggAAAA==";

/**
 * The speech bubble's colour — the site's blue. One constant so a change of colour (the owner is
 * weighing the brand orange, src/pages/brand.js) is this one line.
 */
export const WORDMARK_BUBBLE = "#0A84FF";

/** The mark itself. `ing` is extra html after the n (the opening moment's "reasoning"). */
export function wordmark({ ing = "" } = {}) {
  return `<span class="wordmark" role="img" aria-label="Reason">reas<svg class="wm-bubble" viewBox="-4 0 70 66" aria-hidden="true"><g transform="translate(6 0) skewX(-10)"><path d="M31 6 A25 25 0 1 1 13 49 L4 60 L8 44 A25 25 0 0 1 31 6 Z"/></g></svg>n${ing}</span>`;
}

/** Its styles, for any page's <style>: the site's .wordmark and .wm-bubble, sizes and all. */
export const WORDMARK_CSS = `@font-face{font-family:"Reason Wordmark";font-style:italic;font-weight:400;font-display:block;src:url(${FONT}) format("woff2")}`
  + `.wordmark{flex:none;display:inline-block;color:#2a2520;font:italic 400 1.35rem/1.2 "Reason Wordmark","Instrument Serif","Iowan Old Style",Georgia,serif;letter-spacing:-.01em;white-space:nowrap}`
  + `.wm-bubble{width:.47em;height:.5em;vertical-align:-.07em;margin-inline:0;overflow:visible}`
  + `.wm-bubble path{fill:none;stroke:${WORDMARK_BUBBLE};stroke-width:6;stroke-linejoin:round}`
  + `@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .wordmark{color:#f3efe8}}:root[data-theme=dark] .wordmark{color:#f3efe8}`;
