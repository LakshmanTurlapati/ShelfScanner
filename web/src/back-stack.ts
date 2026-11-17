// Sheets that open inside a view (the camera's label and review sheets) register a closer here,
// so the Android back button closes the newest sheet before App handles its own views.
const closers: Array<() => void> = [];

export function onBack(close: () => void) {
  closers.push(close);
  return () => {
    const index = closers.lastIndexOf(close);
    if (index >= 0) closers.splice(index, 1);
  };
}

export function popBack() {
  const close = closers.pop();
  if (!close) return false;
  close();
  return true;
}
