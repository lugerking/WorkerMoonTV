import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface ScrollableRowProps {
  children: React.ReactNode;
  scrollDistance?: number;
}

export default function ScrollableRow({
  children,
  scrollDistance = 1000,
}: ScrollableRowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showLeftScroll, setShowLeftScroll] = useState(false);
  const [showRightScroll, setShowRightScroll] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const checkScroll = () => {
    if (containerRef.current) {
      const { scrollWidth, clientWidth, scrollLeft } = containerRef.current;

      // 计算是否需要左右滚动按钮
      const threshold = 1; // 容差值，避免浮点误差
      const canScrollRight =
        scrollWidth - (scrollLeft + clientWidth) > threshold;
      const canScrollLeft = scrollLeft > threshold;

      setShowRightScroll(canScrollRight);
      setShowLeftScroll(canScrollLeft);
    }
  };

  useEffect(() => {
    // 多次延迟检查，确保内容已完全渲染
    checkScroll();

    // 监听窗口大小变化
    window.addEventListener('resize', checkScroll);

    // 创建一个 ResizeObserver 来监听容器大小变化
    const resizeObserver = new ResizeObserver(() => {
      // 延迟执行检查
      checkScroll();
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', checkScroll);
      resizeObserver.disconnect();
    };
  }, [children]); // 依赖 children，当子组件变化时重新检查

  // 添加一个额外的效果来监听子组件的变化
  useEffect(() => {
    if (containerRef.current) {
      // 监听 DOM 变化
      const observer = new MutationObserver(() => {
        setTimeout(checkScroll, 100);
      });

      observer.observe(containerRef.current, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
      });

      return () => observer.disconnect();
    }
  }, []);

  const handleScrollRightClick = () => {
    if (containerRef.current) {
      containerRef.current.scrollBy({
        left: scrollDistance,
        behavior: 'smooth',
      });
    }
  };

  const handleScrollLeftClick = () => {
    if (containerRef.current) {
      containerRef.current.scrollBy({
        left: -scrollDistance,
        behavior: 'smooth',
      });
    }
  };

  return (
    <div
      className='relative'
      onMouseEnter={() => {
        setIsHovered(true);
        // 当鼠标进入时重新检查一次
        checkScroll();
      }}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        ref={containerRef}
        className='flex space-x-6 overflow-x-auto scrollbar-hide py-1 sm:py-2 pb-12 sm:pb-14 px-4 sm:px-6'
        onScroll={checkScroll}
      >
        {children}
      </div>
      {showLeftScroll && (
        <div
          className={`absolute left-0 top-0 bottom-0 z-[600] hidden sm:flex items-center transition-opacity duration-200 ${
            isHovered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <div className='pointer-events-none absolute inset-y-0 left-0 w-20 bg-gradient-to-r from-white/90 to-transparent dark:from-zinc-950/90' />
          <button
            onClick={handleScrollLeftClick}
            aria-label='向左滚动'
            className='glass pointer-events-auto relative ml-2 flex h-11 w-11 items-center justify-center rounded-full border border-black/10 shadow-elevated transition-transform hover:scale-105 dark:border-white/10'
          >
            <ChevronLeft className='w-6 h-6 text-gray-700 dark:text-gray-200' />
          </button>
        </div>
      )}

      {showRightScroll && (
        <div
          className={`absolute right-0 top-0 bottom-0 z-[600] hidden sm:flex items-center transition-opacity duration-200 ${
            isHovered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <div className='pointer-events-none absolute inset-y-0 right-0 w-20 bg-gradient-to-l from-white/90 to-transparent dark:from-zinc-950/90' />
          <button
            onClick={handleScrollRightClick}
            aria-label='向右滚动'
            className='glass pointer-events-auto relative mr-2 flex h-11 w-11 items-center justify-center rounded-full border border-black/10 shadow-elevated transition-transform hover:scale-105 dark:border-white/10'
          >
            <ChevronRight className='w-6 h-6 text-gray-700 dark:text-gray-200' />
          </button>
        </div>
      )}
    </div>
  );
}
