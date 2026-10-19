import "@testing-library/jest-dom/vitest";

// jsdom does not lay out, so it has no scrollIntoView.
Element.prototype.scrollIntoView = () => {};
