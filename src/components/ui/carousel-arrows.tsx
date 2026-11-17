import { ChevronLeft, ChevronRight } from "lucide-react";

export function CarouselArrows({
  count,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
}: {
  count: number;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (count < 2) return null;
  return (
    <>
      <button
        className="floating-card-arrow arrow-previous"
        aria-label={previousLabel}
        onClick={onPrevious}
      >
        <ChevronLeft size={22} />
      </button>
      <button
        className="floating-card-arrow arrow-next"
        aria-label={nextLabel}
        onClick={onNext}
      >
        <ChevronRight size={22} />
      </button>
    </>
  );
}
